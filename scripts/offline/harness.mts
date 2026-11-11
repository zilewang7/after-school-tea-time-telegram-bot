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
 *
 * Environment switches:
 * - OFFLINE_VERBOSE=1        print every passing assertion (the runner sets it
 *                            for the per-file logs)
 * - OFFLINE_GREP=<text>      run only the cases whose name contains the text
 * - OFFLINE_DEBUG_HANDLES=1  before exiting, list what would have kept the
 *                            process alive (leaked timers, sockets, servers)
 */
import { mkdirSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRATCH_DIRECTORY = join(tmpdir(), `k-on-bot-offline-${process.pid}`);
const OFFLINE_DB_PATH = join(SCRATCH_DIRECTORY, 'database.sqlite');

/** How long the exit waits for stdout/stderr to drain before giving up */
const FLUSH_TIMEOUT_MS = 2000;

// Set as soon as a test file imports the harness. A file that reaches the db
// layer without setupOfflineDb still gets a database here, not ./database.sqlite
// (the production file): sqlite creates the missing directory on its own.
process.env.DB_PATH = OFFLINE_DB_PATH;

// Telegram call pacing runs a hundred times faster: the cases keep their
// relative timing (coalescing, preemption) without real 500ms gaps. A file that
// tests the pacing itself sets its own value.
process.env.EDIT_COORDINATOR_TIME_SCALE ||= '0.01';

const removeScratchDirectory = (): void => {
    rmSync(SCRATCH_DIRECTORY, { recursive: true, force: true });
};

// Registered on import, not in setupOfflineDb: a file that only reaches the db
// layer through its imports creates the directory too and must not leave it.
process.once('exit', removeScratchDirectory);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    // Exit code as if the signal had ended the process; 'exit' cleans up
    process.once(signal, () => process.exit(128 + constants.signals[signal]));
}

const verbose = process.env.OFFLINE_VERBOSE === '1';
const caseFilter = process.env.OFFLINE_GREP ?? '';

/**
 * Assertion helper, same shape as the e2e harness. `undefined` is accepted and
 * fails, so `expect(reply?.text.includes('x'), …)` reads naturally; any wider
 * type would let a non-empty string pass as true.
 */
export const expect = (condition: boolean | undefined, description: string): void => {
    if (!condition) throw new Error(`Assertion failed: ${description}`);
    if (verbose) console.log(`    ✓ ${description}`);
};

export interface CaseResult {
    name: string;
    ok: boolean;
    error?: string;
    /** Left out by OFFLINE_GREP: reported as neither passed nor failed */
    skipped?: boolean;
}

const HARNESS_FILES = ['/scripts/offline/harness.mts', '/scripts/offline/fake-telegram.mts'];
const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Where a failure happened: the first stack frame inside the repository that is
 * not the harness itself, as a path relative to the repository root.
 */
const failureLocation = (error: unknown): string | undefined => {
    if (!(error instanceof Error) || error.stack === undefined) return undefined;
    for (const line of error.stack.split('\n').slice(1)) {
        const frame = /\(?(?:file:\/\/)?(\/[^():]+):(\d+):\d+\)?$/.exec(line.trim());
        if (frame === null) continue;
        const [, file, lineNumber] = frame;
        if (file === undefined || lineNumber === undefined) continue;
        if (!file.startsWith(REPOSITORY_ROOT) || file.includes('/node_modules/')) continue;
        if (HARNESS_FILES.some((harnessFile) => file.endsWith(harnessFile))) continue;
        return `${relative(REPOSITORY_ROOT, file)}:${lineNumber}`;
    }
    return undefined;
};

export const runCase = async (name: string, body: () => void | Promise<void>): Promise<CaseResult> => {
    if (caseFilter !== '' && !name.includes(caseFilter)) return { name, ok: true, skipped: true };
    console.log(`\n▶ ${name}`);
    try {
        await body();
        return { name, ok: true };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const location = failureLocation(error);
        console.error(`    ✗ ${message}`);
        if (location !== undefined) console.error(`      at ${location}`);
        return { name, ok: false, error: message };
    }
};

const flush = (stream: NodeJS.WriteStream): Promise<void> =>
    new Promise((resolve) => {
        stream.write('', () => resolve());
    });

const reportLiveHandles = (): void => {
    const counts = new Map<string, number>();
    for (const resource of process.getActiveResourcesInfo()) {
        counts.set(resource, (counts.get(resource) ?? 0) + 1);
    }
    const summary = [...counts].map(([resource, count]) => `${resource}×${count}`).join(', ');
    console.error(`[offline] still alive at exit: ${summary === '' ? 'nothing' : summary}`);
};

/**
 * End the process once the output is out. Without this a file that touched the
 * database sits idle for ten more seconds: the connection pool keeps a timer
 * until its idle connections expire. A pipe is written asynchronously, so the
 * streams are drained first or a slow reader would lose the summary.
 */
const exitWhenFlushed = async (exitCode: number): Promise<void> => {
    // One turn of the event loop, so a rejection that is already queued still
    // surfaces as a failure instead of being cut off by the exit
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (process.env.OFFLINE_DEBUG_HANDLES === '1') reportLiveHandles();
    // A closed pipe never calls back; the exit code is already set for that case
    setTimeout(() => process.exit(exitCode), FLUSH_TIMEOUT_MS).unref();
    await Promise.all([flush(process.stdout), flush(process.stderr)]);
    process.exit(exitCode);
};

/**
 * Print the summary and end the process. Synchronous code after this call still
 * runs; anything asynchronous after it races the exit, so do cleanup before.
 */
export const reportResults = (results: CaseResult[]): void => {
    console.log('\n==== offline summary ====');
    for (const result of results) {
        if (result.skipped === true) continue;
        console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`);
    }
    const skipped = results.filter((result) => result.skipped === true).length;
    if (skipped > 0) console.log(`(${skipped} cases skipped by OFFLINE_GREP)`);
    const exitCode = results.some((result) => !result.ok) ? 1 : 0;
    // Set first: if the flush below never completes, the natural exit still fails
    process.exitCode = exitCode;
    void exitWhenFlushed(exitCode);
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
    // Start from an empty directory: a leftover can only come from a killed
    // process that had the same pid
    removeScratchDirectory();
    mkdirSync(SCRATCH_DIRECTORY, { recursive: true });
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
