/**
 * Shared helpers for the bucket-sharing guard scripts: env parsing, the SMS
 * alert channel, the local state file, and the IAM grant itself.
 *
 * The grant is deliberately narrow -- `legacyObjectReader` carries
 * storage.objects.get but no storage.objects.list, so the other side can read
 * exactly the objects we name in a request and cannot enumerate the bucket.
 */
import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Storage } from '@google-cloud/storage';

export const BYTES_PER_GB = 1024 ** 3;
export const DEFAULT_SA = 'service-498043028993@gcp-sa-aiplatform.iam.gserviceaccount.com';
export const DEFAULT_ROLE = 'roles/storage.legacyObjectReader';
export const DEFAULT_PREFIX = 'media/';
export const CONDITION_TITLE = 'hub-vertex-media-read';
export const SA_PATTERN = /(service-\d+)@gcp-sa-aiplatform\.iam\.gserviceaccount\.com/;

export const STATE_FILE = resolve(process.cwd(), 'tmp/gcs-guard-state.json');
export const REVOKE_HINT = 'cd ~/dockers/k-on-bot && node scripts/guard/gcs-share.mjs revoke';

export const envNumber = (name, fallback) => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
};

export const formatGb = (bytes) => `${(bytes / BYTES_PER_GB).toFixed(2)}GB`;

export const readState = () => {
    try {
        return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    } catch {
        return { alerts: {} };
    }
};

export const writeState = (state) => {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
};

const normalizeAlertUrl = (raw) => {
    if (!raw) return null;
    if (raw.startsWith('generic://')) return `https://${raw.slice('generic://'.length)}`;
    if (raw.startsWith('https://') || raw.startsWith('http://')) return raw;
    throw new Error(`unsupported alert url (expected generic:// or https://): ${raw.slice(0, 24)}`);
};

export const sendAlert = async (title, message) => {
    const url = normalizeAlertUrl(process.env.SHOUTRRR_ALERT_URL);
    if (!url) throw new Error('SHOUTRRR_ALERT_URL is not set');
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, message }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`alert webhook HTTP ${response.status}: ${text.slice(0, 200)}`);
    console.log(`alert sent: ${title}`);
};

export const credentialPath = () =>
    process.env.GOOGLE_APPLICATION_CREDENTIALS ?? resolve(process.cwd(), 'gcp-sa.json');

export const requireCredentials = () => {
    const path = credentialPath();
    if (!existsSync(path)) throw new Error(`credentials not found: ${path}`);
    return path;
};

const bucketOf = (path) => {
    const name = process.env.GCS_BUCKET;
    if (!name) throw new Error('GCS_BUCKET is required (.env)');
    return new Storage({ keyFilename: path }).bucket(name);
};

const asMember = (serviceAccount) =>
    serviceAccount.startsWith('serviceAccount:') ? serviceAccount : `serviceAccount:${serviceAccount}`;

export const buildCondition = (prefix = DEFAULT_PREFIX) => ({
    title: CONDITION_TITLE,
    description: `Read ${process.env.GCS_BUCKET} objects under ${prefix} for the hub's Vertex project`,
    expression: `resource.name.startsWith("projects/_/buckets/${process.env.GCS_BUCKET}/objects/${prefix}")`,
});

const matches = (binding, member, role) => binding.role === role && (binding.members ?? []).includes(member);

export const describeBinding = (binding) =>
    `${binding.role} <- ${(binding.members ?? []).join(', ')}` +
    (binding.condition ? ` [${binding.condition.expression}]` : '');

const readPolicy = async (bucket) => {
    const [policy] = await bucket.iam.getPolicy({ requestedPolicyVersion: 3 });
    return policy;
};

const writePolicy = async (bucket, policy) => {
    policy.version = 3;
    await bucket.iam.setPolicy(policy);
};

export const listShareBindings = async (serviceAccount = DEFAULT_SA, role = DEFAULT_ROLE) => {
    const bucket = bucketOf(requireCredentials());
    const policy = await readPolicy(bucket);
    const member = asMember(serviceAccount);
    return (policy.bindings ?? []).filter((binding) => matches(binding, member, role));
};

export const readSharePolicy = async () => {
    const bucket = bucketOf(requireCredentials());
    return readPolicy(bucket);
};

export const describePolicy = (policy) => {
    const bindings = policy.bindings ?? [];
    return bindings.length === 0 ? '  (no bindings)' : bindings.map((b) => `  ${describeBinding(b)}`).join('\n');
};

export const grantServiceAgent = async ({
    serviceAccount,
    role = DEFAULT_ROLE,
    prefix = DEFAULT_PREFIX,
    withCondition = true,
    dryRun = false,
}) => {
    const bucket = bucketOf(requireCredentials());
    const policy = await readPolicy(bucket);
    const member = asMember(serviceAccount);
    if ((policy.bindings ?? []).some((binding) => matches(binding, member, role))) {
        return { changed: false, binding: null };
    }
    const binding = { role, members: [member], ...(withCondition ? { condition: buildCondition(prefix) } : {}) };
    if (!dryRun) await writePolicy(bucket, { ...policy, bindings: [...(policy.bindings ?? []), binding] });
    return { changed: true, binding };
};

export const revokeServiceAgent = async ({ serviceAccount, role = DEFAULT_ROLE, dryRun = false }) => {
    const bucket = bucketOf(requireCredentials());
    const policy = await readPolicy(bucket);
    const member = asMember(serviceAccount);
    const removed = (policy.bindings ?? []).filter((binding) => matches(binding, member, role));
    if (removed.length === 0) return { changed: false, removed: 0 };
    if (!dryRun) {
        await writePolicy(bucket, {
            ...policy,
            bindings: (policy.bindings ?? []).filter((binding) => !matches(binding, member, role)),
        });
    }
    return { changed: true, removed: removed.length };
};

/** Mint an access token for the guard's own service account. */
export const fetchAccessToken = async (path = requireCredentials()) => {
    const storage = new Storage({ keyFilename: path });
    const result = await storage.authClient.getAccessToken();
    const token = typeof result === 'string' ? result : result?.token;
    if (!token) throw new Error('could not acquire an access token');
    return token;
};
