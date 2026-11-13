/**
 * Credentials, lanes and safety gates for the thinking-effort probe.
 *
 * The probe reads ONLY `.env.test` (never `.env`) and never prints a value:
 * everything it reports about the environment is a key name, a host or a
 * boolean. In the test container the same values arrive through compose's
 * `env_file`, so an existing process variable wins and the file is only a
 * fallback for a host-side `--dry-run`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseDotenv } from 'dotenv';
import { createRedactor } from './effort-errors.mts';
import { PROBE_PLATFORMS, type ProbePlatform } from './effort-types.mts';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The one env file the probe may read; the name check below is deliberate */
export const PROBE_ENV_FILE = '.env.test';

export interface ProbeEnvironment {
    /** Process env overlaid with the values `.env.test` supplied for missing keys */
    readonly values: Readonly<Record<string, string>>;
    /** Absolute path of the env file that was read, null when absent */
    readonly envFilePath: string | null;
    readonly usedEnvFile: boolean;
    /** How many keys the file contributed; never their values */
    readonly filledKeys: number;
    readonly warnings: readonly string[];
    /** Secret values of this run, handed to the redactor only */
    readonly secrets: readonly string[];
}

const envValueOf = (values: Readonly<Record<string, string>>, key: string): string => values[key] ?? '';

/** Read `.env.test` without ever touching `.env`, then overlay it on process.env */
export const loadProbeEnvironment = (
    options: { readonly processEnvironment?: NodeJS.ProcessEnv; readonly repositoryRoot?: string } = {}
): ProbeEnvironment => {
    const processEnvironment = options.processEnvironment ?? process.env;
    const repositoryRoot = options.repositoryRoot ?? REPOSITORY_ROOT;
    const envFilePath = join(repositoryRoot, PROBE_ENV_FILE);
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(processEnvironment)) {
        if (value !== undefined) values[key] = value;
    }

    const warnings: string[] = [];
    let filledKeys = 0;
    let usedEnvFile = false;
    if (!envFilePath.endsWith(PROBE_ENV_FILE) || !envFilePath.includes(PROBE_ENV_FILE)) {
        // Unreachable by construction; a mis-built path must not silently read .env
        throw new Error(`the probe may only read ${PROBE_ENV_FILE}, got ${envFilePath}`);
    }
    const fileExists = existsSync(envFilePath);
    if (fileExists) {
        const parsed = parseDotenv(readFileSync(envFilePath, 'utf8'));
        usedEnvFile = true;
        for (const [key, value] of Object.entries(parsed)) {
            if (values[key] !== undefined && values[key] !== '') continue;
            values[key] = value;
            filledKeys += 1;
        }
    } else {
        warnings.push(`no ${PROBE_ENV_FILE} next to the repository; relying on the process environment`);
    }

    const secrets = secretValuesOf(values);
    return { values, envFilePath: fileExists ? envFilePath : null, usedEnvFile, filledKeys, warnings, secrets };
};

const SECRET_KEY = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS)$/i;

/** Values that must never appear in a log line or an evidence file */
const secretValuesOf = (values: Readonly<Record<string, string>>): string[] =>
    Object.entries(values)
        .filter(([key, value]) => SECRET_KEY.test(key) && value.length >= 8)
        .map(([, value]) => value);

/** The redactor for one run: generic credential shapes plus this run's values */
export const redactorOf = (environment: ProbeEnvironment): ((text: string) => string) =>
    createRedactor(environment.secrets);

export interface ProbeLaneConfiguration {
    readonly platform: ProbePlatform;
    /** Stable lane name: vertex-adc, ephone, official-xai, … */
    readonly laneId: string;
    readonly baseUrl: string | null;
    readonly host: string | null;
    readonly apiKey: string | null;
    readonly vertexai: boolean;
    readonly project: string | null;
    readonly location: string | null;
    /** Missing variables or files that would make the lane fail every request */
    readonly problems: readonly string[];
}

const hostOf = (baseUrl: string): string | null => {
    if (baseUrl === '') return null;
    try {
        return new URL(baseUrl).host;
    } catch {
        return baseUrl;
    }
};

const laneIdForHost = (host: string | null, kind: 'openai' | 'anthropic' | 'grok' | 'deepseek' | 'mimo'): string => {
    if (kind === 'openai') {
        if (host === null) return 'official-openai';
        if (host.endsWith('ephone.ai')) return 'ephone';
        if (host.endsWith('openai.com')) return 'official-openai';
        return `openai-relay:${host}`;
    }
    if (kind === 'anthropic') {
        if (host === null) return 'official-anthropic';
        if (host.endsWith('ephone.ai')) return 'ephone';
        if (host.endsWith('anthropic.com')) return 'official-anthropic';
        return `anthropic-relay:${host}`;
    }
    if (kind === 'grok') {
        if (host === null || host.endsWith('x.ai')) return 'official-xai';
        return `grok-relay:${host}`;
    }
    if (kind === 'deepseek') {
        if (host === null || host.endsWith('deepseek.com')) return 'official-deepseek';
        return `deepseek-relay:${host}`;
    }
    if (host === null || host.endsWith('xiaomimimo.com')) return 'official-mimo';
    return `mimo-relay:${host}`;
}

/**
 * Irreversible short fingerprint of one lane identity (a credential or a
 * project). Only this hash may enter a laneId: the value itself must never be
 * logged, and a changed key/project must invalidate old probe data through the
 * lane signature.
 */
const laneFingerprint = (value: string): string =>
    createHash('sha256').update(value).digest('hex').slice(0, 8);

/** Append the opaque `#k…` (credential) or `#p…` (project) suffix when known */
const withLaneFingerprint = (laneId: string, kind: 'key' | 'project', value: string | null): string => {
    if (value === null || value === '') return laneId;
    return `${laneId}#${kind === 'key' ? 'k' : 'p'}${laneFingerprint(value)}`;
};

const openAiCompatibleLane = (
    platform: ProbePlatform,
    values: Readonly<Record<string, string>>,
    options: {
        readonly urlKey: string;
        readonly keyKey: string;
        readonly kind: 'openai' | 'anthropic' | 'grok' | 'deepseek' | 'mimo';
        readonly fallbackUrlKey?: string;
        readonly fallbackKeyKey?: string;
        readonly defaultBaseUrl: string;
    }
): ProbeLaneConfiguration => {
    const explicitUrl = envValueOf(values, options.urlKey);
    const fallbackUrl = options.fallbackUrlKey === undefined ? '' : envValueOf(values, options.fallbackUrlKey);
    const baseUrl = explicitUrl !== '' ? explicitUrl : fallbackUrl !== '' ? fallbackUrl : options.defaultBaseUrl;
    const explicitKey = envValueOf(values, options.keyKey);
    const fallbackKey = options.fallbackKeyKey === undefined ? '' : envValueOf(values, options.fallbackKeyKey);
    const apiKey = explicitKey !== '' ? explicitKey : fallbackKey;
    const problems: string[] = [];
    if (apiKey === '') problems.push(`${options.keyKey} is not set`);
    if (explicitUrl === '' && fallbackUrl === '') problems.push(`${options.urlKey} is not set (using ${options.defaultBaseUrl})`);
    const host = hostOf(baseUrl);
    const laneId = withLaneFingerprint(
        laneIdForHost(host, options.kind) + (explicitKey === '' && fallbackKey !== '' ? ':openai-fallback' : ''),
        'key',
        apiKey
    );
    return {
        platform,
        laneId,
        baseUrl,
        host,
        apiKey: apiKey === '' ? null : apiKey,
        vertexai: false,
        project: null,
        location: null,
        problems,
    };
};

/**
 * DeepSeek lane, derived like production's constructor: the official URL (or
 * DEEPSEEK_API_URL) while the DeepSeek key is set, and the OpenAI client only
 * when that key is missing. A missing URL alone never falls back to the OpenAI
 * URL (production uses the official default instead).
 */
const deepseekLane = (values: Readonly<Record<string, string>>): ProbeLaneConfiguration => {
    const url = envValueOf(values, 'DEEPSEEK_API_URL');
    const key = envValueOf(values, 'DEEPSEEK_API_KEY');
    if (key !== '') {
        const baseUrl = url !== '' ? url : 'https://api.deepseek.com/v1';
        const host = hostOf(baseUrl);
        return {
            platform: 'deepseek',
            laneId: withLaneFingerprint(laneIdForHost(host, 'deepseek'), 'key', key),
            baseUrl,
            host,
            apiKey: key,
            vertexai: false,
            project: null,
            location: null,
            problems: [],
        };
    }
    const openAiUrl = envValueOf(values, 'OPENAI_API_URL');
    const openAiKey = envValueOf(values, 'OPENAI_API_KEY');
    const baseUrl = openAiUrl !== '' ? openAiUrl : 'https://api.openai.com/v1';
    const host = hostOf(baseUrl);
    // Production builds the fallback client only when the OpenAI key is there;
    // a missing OpenAI key is the one thing that makes the fallback unready.
    const problems =
        openAiKey === ''
            ? ['DEEPSEEK_API_KEY is not set and OPENAI_API_KEY is not set, so the production fallback client cannot be built']
            : [];
    return {
        platform: 'deepseek',
        laneId: withLaneFingerprint(`${laneIdForHost(host, 'openai')}:openai-fallback`, 'key', openAiKey),
        baseUrl,
        host,
        apiKey: openAiKey === '' ? null : openAiKey,
        vertexai: false,
        project: null,
        location: null,
        problems,
    };
};

/** Lane of each platform, derived exactly like the production clients' constructors */
export const laneConfigurationsOf = (
    environment: ProbeEnvironment,
    options: { readonly credentialsFileExists?: (path: string) => boolean } = {}
): Readonly<Record<ProbePlatform, ProbeLaneConfiguration>> => {
    const values = environment.values;
    const credentialsFileExists = options.credentialsFileExists ?? existsSync;

    const geminiApiUrl = envValueOf(values, 'GEMINI_API_URL');
    const geminiProblem: string[] = [];
    const project = envValueOf(values, 'GOOGLE_CLOUD_PROJECT');
    const location = envValueOf(values, 'GOOGLE_CLOUD_LOCATION') || 'global';
    const credentialsPath = envValueOf(values, 'GOOGLE_APPLICATION_CREDENTIALS');
    const geminiApiKey = envValueOf(values, 'GEMINI_API_KEY');
    let gemini: ProbeLaneConfiguration;
    if (geminiApiUrl !== '') {
        if (geminiApiKey === '') geminiProblem.push('GEMINI_API_KEY is not set for GEMINI_API_URL');
        gemini = {
            platform: 'gemini',
            laneId: withLaneFingerprint(`gemini-relay:${hostOf(geminiApiUrl) ?? geminiApiUrl}`, 'key', geminiApiKey),
            baseUrl: geminiApiUrl,
            host: hostOf(geminiApiUrl),
            apiKey: geminiApiKey === '' ? null : geminiApiKey,
            vertexai: false,
            project: project === '' ? null : project,
            location,
            problems: geminiProblem,
        };
    } else if (project !== '' && credentialsPath !== '' && credentialsFileExists(credentialsPath)) {
        gemini = {
            platform: 'gemini',
            laneId: withLaneFingerprint(`vertex-adc@${location}`, 'project', project),
            baseUrl: null,
            host: null,
            apiKey: null,
            vertexai: true,
            project,
            location,
            problems: [],
        };
    } else if (geminiApiKey !== '') {
        gemini = {
            platform: 'gemini',
            laneId: withLaneFingerprint('vertex-express', 'key', geminiApiKey),
            baseUrl: null,
            host: null,
            apiKey: geminiApiKey,
            vertexai: true,
            project: project === '' ? null : project,
            location,
            problems: [],
        };
    } else {
        gemini = {
            platform: 'gemini',
            laneId: 'unconfigured',
            baseUrl: null,
            host: null,
            apiKey: null,
            vertexai: true,
            project: project === '' ? null : project,
            location,
            problems: ['neither GEMINI_API_URL nor ADC credentials nor GEMINI_API_KEY are set'],
        };
    }

    const anthropicUrl = envValueOf(values, 'ANTHROPIC_API_URL');
    const openAiUrl = envValueOf(values, 'OPENAI_API_URL');
    const anthropicBase = anthropicUrl !== '' ? anthropicUrl : openAiUrl.replace(/\/v1\/?$/, '');

    return {
        gemini,
        openai: openAiCompatibleLane('openai', values, {
            urlKey: 'OPENAI_API_URL',
            keyKey: 'OPENAI_API_KEY',
            kind: 'openai',
            defaultBaseUrl: 'https://api.openai.com/v1',
        }),
        anthropic: {
            platform: 'anthropic',
            laneId: withLaneFingerprint(
                laneIdForHost(hostOf(anthropicBase), 'anthropic'),
                'key',
                envValueOf(values, 'ANTHROPIC_API_KEY') !== ''
                    ? envValueOf(values, 'ANTHROPIC_API_KEY')
                    : envValueOf(values, 'OPENAI_API_KEY')
            ),
            baseUrl: anthropicBase === '' ? null : anthropicBase,
            host: hostOf(anthropicBase),
            apiKey:
                envValueOf(values, 'ANTHROPIC_API_KEY') !== ''
                    ? envValueOf(values, 'ANTHROPIC_API_KEY')
                    : envValueOf(values, 'OPENAI_API_KEY') === ''
                      ? null
                      : envValueOf(values, 'OPENAI_API_KEY'),
            vertexai: false,
            project: null,
            location: null,
            problems:
                (envValueOf(values, 'ANTHROPIC_API_KEY') === '' && envValueOf(values, 'OPENAI_API_KEY') === ''
                    ? ['ANTHROPIC_API_KEY / OPENAI_API_KEY are not set']
                    : []),
        },
        grok: openAiCompatibleLane('grok', values, {
            urlKey: 'GROK_API_URL',
            keyKey: 'GROK_API_KEY',
            kind: 'grok',
            // Production constructs its OpenAI client with baseURL undefined
            // when GROK_API_URL is unset, so the SDK default applies. The
            // missing-URL problem keeps the lane from spending there.
            defaultBaseUrl: 'https://api.openai.com/v1',
        }),
        deepseek: deepseekLane(values),
        mimo: openAiCompatibleLane('mimo', values, {
            urlKey: 'MIMO_API_URL',
            keyKey: 'MIMO_API_KEY',
            kind: 'mimo',
            defaultBaseUrl: 'https://api.xiaomimimo.com/v1',
        }),
    };
};

/**
 * One string that changes when the traffic path changes (probe plan §2.1):
 * the catalog stores it, and a mismatch makes old probe data stale.
 */
export const laneSignatureOf = (lanes: Readonly<Record<ProbePlatform, ProbeLaneConfiguration>>): string =>
    PROBE_PLATFORMS.map((platform) => lanes[platform].laneId).join('|');

export interface ProbeGate {
    readonly name: string;
    readonly ok: boolean;
    readonly detail: string;
}

export interface ProbeGates {
    readonly ok: boolean;
    readonly gates: readonly ProbeGate[];
    readonly reasons: readonly string[];
}

const TEST_DATABASE_NAME = 'database.test.sqlite';

/**
 * The hard gate of a real run: only the test instance may spend money on model
 * APIs, and its DB_PATH must point at the test database. A dry-run reports the
 * same gates without being stopped by them.
 */
export const evaluateRunGates = (environment: ProbeEnvironment): ProbeGates => {
    const values = environment.values;
    const testInstance = envValueOf(values, 'TEST_INSTANCE') === '1';
    const dbPath = envValueOf(values, 'DB_PATH');
    const testDatabase = dbPath === TEST_DATABASE_NAME || dbPath.endsWith(`/${TEST_DATABASE_NAME}`);
    const gates: ProbeGate[] = [
        {
            name: 'TEST_INSTANCE=1',
            ok: testInstance,
            detail: testInstance ? 'the test instance' : 'not the test instance',
        },
        {
            name: `DB_PATH ends with ${TEST_DATABASE_NAME}`,
            ok: testDatabase,
            detail: dbPath === '' ? 'DB_PATH is not set' : dbPath,
        },
    ];
    const reasons = gates.filter((gate) => !gate.ok).map((gate) => gate.name);
    return { ok: gates.every((gate) => gate.ok), gates, reasons };
};
