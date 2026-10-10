#!/usr/bin/env node
/**
 * Manage the bucket-level grant that lets the hub's upstream Vertex project read
 * back the media we already hand it as gs:// URIs.
 *
 *   node scripts/guard/gcs-share.mjs status
 *   node scripts/guard/gcs-share.mjs grant   [--sa <email>] [--prefix media/] [--no-condition] [--dry-run]
 *   node scripts/guard/gcs-share.mjs revoke  [--sa <email>] [--dry-run]
 *   node scripts/guard/gcs-share.mjs revoke-all
 *
 * Credentials come from GOOGLE_APPLICATION_CREDENTIALS or ./gcp-sa.json.
 */
import 'dotenv/config';
import {
    DEFAULT_SA,
    DEFAULT_ROLE,
    DEFAULT_PREFIX,
    describeBinding,
    describePolicy,
    grantServiceAgent,
    listShareBindings,
    readSharePolicy,
    requireCredentials,
    revokeServiceAgent,
} from './lib.mjs';

const parseArgs = (argv) => {
    const flags = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) {
            flags._.push(arg);
            continue;
        }
        const [rawKey, inlineValue] = arg.slice(2).split('=');
        const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (inlineValue !== undefined) flags[key] = inlineValue;
        else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
        else flags[key] = true;
    }
    return flags;
};

const flags = parseArgs(process.argv.slice(2));
const command = flags._[0] ?? 'status';
const serviceAccount = flags.sa ?? process.env.HUB_VERTEX_SA ?? DEFAULT_SA;
const role = flags.role ?? DEFAULT_ROLE;
const prefix = flags.prefix ?? DEFAULT_PREFIX;
const dryRun = Boolean(flags.dryRun);

const main = async () => {
    requireCredentials();

    if (command === 'status') {
        const bindings = await listShareBindings(serviceAccount, role);
        const policy = await readSharePolicy();
        console.log(`bucket: gs://${process.env.GCS_BUCKET}`);
        console.log(`grant target: ${serviceAccount} (${role})`);
        console.log(`present: ${bindings.length > 0 ? 'YES' : 'no'}`);
        console.log('all bindings:');
        console.log(describePolicy(policy));
        return;
    }

    if (command === 'grant') {
        const result = await grantServiceAgent({
            serviceAccount,
            role,
            prefix,
            withCondition: !flags.noCondition,
            dryRun,
        });
        if (!result.changed) {
            console.log('already granted; nothing to do');
            return;
        }
        console.log(`granting: ${describeBinding(result.binding)}`);
        console.log(dryRun ? '(--dry-run: nothing written)' : 'done; IAM propagation usually takes under 2 minutes');
        return;
    }

    if (command === 'revoke') {
        const result = await revokeServiceAgent({ serviceAccount, role, dryRun });
        if (!result.changed) {
            console.log('no matching binding; nothing to revoke');
            return;
        }
        console.log(dryRun ? `(--dry-run: would revoke ${result.removed} binding(s))` : `revoked ${result.removed} binding(s)`);
        return;
    }

    if (command === 'revoke-all') {
        const policy = await readSharePolicy();
        const targets = (policy.bindings ?? [])
            .filter((binding) => binding.role === role && binding.condition?.title?.startsWith('hub-vertex-media-read'))
            .flatMap((binding) => binding.members ?? []);
        if (targets.length === 0) {
            console.log('no hub share bindings found');
            return;
        }
        for (const member of targets) {
            const result = await revokeServiceAgent({
                serviceAccount: member.replace(/^serviceAccount:/, ''),
                role,
                dryRun,
            });
            console.log(`${dryRun ? 'would revoke' : 'revoked'} ${member}`);
        }
        return;
    }

    console.error(`unknown command: ${command}`);
    console.error('usage: gcs-share.mjs status|grant|revoke|revoke-all [--sa <email>] [--prefix <p>] [--no-condition] [--dry-run]');
    process.exit(2);
};

main().catch((error) => {
    console.error('failed:', error?.message ?? error);
    process.exit(1);
});
