/**
 * Offline test harness: runs production modules against a scratch sqlite file.
 *
 * No containers, no Telegram, no network — so these cases are deterministic and
 * safe to run on every change, unlike the e2e suite. DB_PATH is pointed at a
 * throwaway database BEFORE any db module is imported, which is why every
 * import here is dynamic.
 *
 * The scratch database belongs to this process alone (a directory in the OS
 * temp dir named after the pid, removed on exit), so a full `pnpm test:offline`
 * and single test files can run at the same time without sharing or wiping
 * each other's state.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRATCH_DIRECTORY = join(tmpdir(), `k-on-bot-offline-${process.pid}`);
const OFFLINE_DB_PATH = join(SCRATCH_DIRECTORY, 'database.sqlite');

// Set as soon as a test file imports the harness: a file that reaches the db
// layer without setupOfflineDb then fails on a missing directory instead of
// opening ./database.sqlite, the production file.
process.env.DB_PATH = OFFLINE_DB_PATH;

/** Assertion helper, same shape as the e2e harness */
export const expect = (condition: boolean, description: string): void => {
    if (!condition) throw new Error(`Assertion failed: ${description}`);
    console.log(`    ✓ ${description}`);
};

export interface CaseResult {
    name: string;
    ok: boolean;
    error?: string;
}

export const runCase = async (name: string, body: () => Promise<void>): Promise<CaseResult> => {
    console.log(`\n▶ ${name}`);
    try {
        await body();
        return { name, ok: true };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`    ✗ ${message}`);
        return { name, ok: false, error: message };
    }
};

export const reportResults = (results: CaseResult[]): void => {
    console.log('\n==== offline summary ====');
    for (const result of results) {
        console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`);
    }
    if (results.some((result) => !result.ok)) process.exit(1);
};

const removeScratchDirectory = (): void => {
    rmSync(SCRATCH_DIRECTORY, { recursive: true, force: true });
};

/**
 * Start from an empty directory (a leftover can only come from a killed
 * process that had the same pid) and remove it again on exit, including an
 * interrupted run.
 */
const prepareScratchDirectory = (): void => {
    removeScratchDirectory();
    mkdirSync(SCRATCH_DIRECTORY, { recursive: true });
    process.once('exit', removeScratchDirectory);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        // Exit code as if the signal had ended the process; 'exit' cleans up
        process.once(signal, () => process.exit(128 + constants.signals[signal]));
    }
};

export interface OfflineDb {
    Message: typeof import('../../src/db/messageDTO.js').Message;
    queries: typeof import('../../src/db/queries/context-queries.js');
    saveMessage: typeof import('../../src/db/index.js').saveMessage;
    putCachedMedia: typeof import('../../src/services/media-cache-service.js').putCachedMedia;
}

/**
 * Point the app at the scratch database, import the db layer and create the
 * schema. Returns the pieces the cases need.
 */
const createOfflineDb = async (): Promise<OfflineDb> => {
    prepareScratchDirectory();
    process.env.DB_PATH = OFFLINE_DB_PATH;
    // The AI platforms build their clients at import time and refuse to exist
    // without credentials. Nothing here ever sends a request, so a placeholder
    // is enough to let the context builder be imported.
    for (const key of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GROK_API_KEY', 'MIMO_API_KEY']) {
        process.env[key] ||= 'offline-placeholder';
    }

    const { Message } = await import('../../src/db/messageDTO.js');
    const dbIndex = await import('../../src/db/index.js');
    const queries = await import('../../src/db/queries/context-queries.js');
    const { putCachedMedia } = await import('../../src/services/media-cache-service.js');

    // db/index.ts starts the schema sync at import time; a second sync would
    // race it (SQLITE_BUSY), so wait for that one instead of starting another.
    await dbIndex.dbReady;

    return { Message, queries, saveMessage: dbIndex.saveMessage, putCachedMedia };
};

let offlineDb: Promise<OfflineDb> | undefined;

/** Once per process: a second reset would pull the file from under the open connection */
export const setupOfflineDb = (): Promise<OfflineDb> => (offlineDb ??= createOfflineDb());

export const OFFLINE_CHAT_ID = -1009999999999;

let nextMessageId = 1000;
/** Monotonic ids, so "newer message = larger id" holds like on Telegram */
export const takeMessageId = (): number => (nextMessageId += 1);
