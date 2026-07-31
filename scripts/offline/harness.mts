/**
 * Offline test harness: runs production modules against a scratch sqlite file.
 *
 * No containers, no Telegram, no network — so these cases are deterministic and
 * safe to run on every change, unlike the e2e suite. DB_PATH is pointed at a
 * throwaway database BEFORE any db module is imported, which is why every
 * import here is dynamic.
 */
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OFFLINE_DB_PATH = join(repoRoot, 'database.offline.sqlite');

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

/** Drop the scratch database so each run starts from a known empty state */
const resetDatabaseFile = (): void => {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
        rmSync(`${OFFLINE_DB_PATH}${suffix}`, { force: true });
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
export const setupOfflineDb = async (): Promise<OfflineDb> => {
    resetDatabaseFile();
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

export const OFFLINE_CHAT_ID = -1009999999999;

let nextMessageId = 1000;
/** Monotonic ids, so "newer message = larger id" holds like on Telegram */
export const takeMessageId = (): number => (nextMessageId += 1);
