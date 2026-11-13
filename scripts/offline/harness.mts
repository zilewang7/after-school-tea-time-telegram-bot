/**
 * Offline test harness: runs production modules against a scratch sqlite file.
 *
 * No containers, no Telegram, no network — so these cases are deterministic and
 * safe to run on every change, unlike the e2e suite. DB_PATH is pointed at a
 * throwaway database BEFORE any db module is imported, which is why every
 * import here is dynamic.
 *
 * The scratch database belongs to this test file alone (a directory named
 * after the pid, kept in memory where the system allows and removed when the
 * file ends), so a full `pnpm test:offline` and single test files can run at
 * the same time without sharing or wiping each other's state. In a shared
 * worker (support/worker/) the files of one process use that directory one
 * after the other; each has its own copy of this module and of everything
 * else in the repository.
 *
 * Environment switches:
 * - OFFLINE_VERBOSE=1        print every passing assertion (the runner sets it
 *                            for the per-file logs)
 * - OFFLINE_GREP=<text>      run only the cases whose name contains the text
 * - OFFLINE_DEBUG_HANDLES=1  after the summary, list what still keeps the
 *                            process alive (timers, sockets, servers) and
 *                            where each was created
 */
import { mkdirSync } from 'node:fs';
import { constants } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveHandleOrigins, noteCaseStart, trackLiveHandles } from './support/live-handles.mts';
import { removeScratchDirectoryOf, scratchDirectoryOf } from './support/scratch-directory.mts';

const SCRATCH_DIRECTORY = scratchDirectoryOf(process.pid);
const OFFLINE_DB_PATH = join(SCRATCH_DIRECTORY, 'database.sqlite');

/**
 * How long a file may keep running after its summary before it is ended and
 * fails. Work the cases left behind normally finishes within milliseconds; what
 * is still alive after this is a leak (a server never closed, an interval never
 * cleared), and an error it would raise later could no longer be seen.
 */
const LINGER_LIMIT_MS = 3000;

// Set as soon as a test file imports the harness. A file that reaches the db
// layer without setupOfflineDb still gets a database here, not ./database.sqlite
// (the production file): sqlite creates the missing directory on its own.
process.env.DB_PATH = OFFLINE_DB_PATH;

// Telegram call pacing runs a hundred times faster: the cases keep their
// relative timing (coalescing, preemption) without real 500ms gaps. A file that
// tests the pacing itself sets its own value.
process.env.EDIT_COORDINATOR_TIME_SCALE ||= '0.01';

// The pool lets go of an unused connection right away. With the default ten
// seconds its idle timer would be the last thing keeping a finished file alive.
process.env.DB_POOL_IDLE_MS ||= '50';

// Tiering is on in production by default; existing cases assert today's
// full-capability behavior, so the harness keeps it off unless a case opts in.
process.env.ACCESS_TIERS ||= '0';

const removeScratchDirectory = (): void => removeScratchDirectoryOf(process.pid);

// Registered on import, not in setupOfflineDb: a file that only reaches the db
// layer through its imports creates the directory too and must not leave it.
process.once('exit', removeScratchDirectory);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    // Exit code as if the signal had ended the process; 'exit' cleans up
    process.once(signal, () => process.exit(128 + constants.signals[signal]));
}

const verbose = process.env.OFFLINE_VERBOSE === '1';
const debugHandles = process.env.OFFLINE_DEBUG_HANDLES === '1';
// From the start: a handle can only be traced to its origin when it is created
if (debugHandles) trackLiveHandles();
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
    // Written to the stream itself: the runner counts these lines, and a case
    // that runs at the same time may have replaced console.log to keep quiet
    process.stdout.write(`\n▶ ${name}\n`);
    if (debugHandles) noteCaseStart(name);
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

/** Resolves once everything written to the stream so far is out, or the stream is gone */
const flush = (stream: NodeJS.WriteStream): Promise<void> =>
    new Promise((resolve) => {
        if (stream.destroyed || !stream.writable) {
            resolve();
            return;
        }
        // A reader that went away answers with an error or a close, not with the callback
        stream.once('error', () => resolve());
        stream.once('close', () => resolve());
        stream.write('', () => resolve());
    });

const describeLiveHandles = (): string => {
    const counts = new Map<string, number>();
    for (const resource of process.getActiveResourcesInfo()) {
        counts.set(resource, (counts.get(resource) ?? 0) + 1);
    }
    const summary = [...counts].map(([resource, count]) => `${resource}×${count}`).join(', ');
    return summary === '' ? 'nothing' : summary;
};

/** Ends a file that is still running long after its summary. The file fails: it did not end what it started. */
const endLingeringProcess = async (): Promise<void> => {
    console.error(`[offline] still running ${LINGER_LIMIT_MS}ms after the summary, ending it; alive: ${describeLiveHandles()}`);
    if (debugHandles) {
        for (const origin of liveHandleOrigins()) console.error(`[offline]   ${origin}`);
    } else {
        console.error('[offline] run the file with OFFLINE_DEBUG_HANDLES=1 to see where they were created');
    }
    await Promise.all([flush(process.stdout), flush(process.stderr)]);
    process.exit(1);
};

/**
 * Print the summary. The process then ends on its own as soon as the work the
 * cases started is finished, the way any Node program does, so an error in that
 * late work (a timer that throws, a promise nobody awaited that rejects) still
 * ends the process with a failure. Do cleanup (closing servers) before the call:
 * whatever stays open keeps the file running until LINGER_LIMIT_MS, and the
 * file then fails.
 */
export const reportResults = (results: CaseResult[]): void => {
    console.log('\n==== offline summary ====');
    for (const result of results) {
        if (result.skipped === true) continue;
        console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`);
    }
    const skipped = results.filter((result) => result.skipped === true).length;
    if (skipped > 0) console.log(`(${skipped} cases skipped by OFFLINE_GREP)`);
    // Only ever raised: something outside the cases may have failed the file already
    if (results.some((result) => !result.ok)) process.exitCode = 1;

    if (debugHandles) {
        const reportedAt = performance.now();
        console.error(`[offline] alive at the summary: ${describeLiveHandles()}`);
        process.once('exit', () => {
            console.error(`[offline] ended ${Math.round(performance.now() - reportedAt)}ms after the summary`);
        });
    }
    // unref: this timer alone must not keep the process alive
    setTimeout(() => void endLingeringProcess(), LINGER_LIMIT_MS).unref();
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

/** Once per test file: a second reset would pull the file from under the open connection */
export const setupOfflineDb = (): Promise<OfflineDb> => (offlineDb ??= createOfflineDb());

export const OFFLINE_CHAT_ID = -1009999999999;

let nextMessageId = 1000;
/** Monotonic ids, so "newer message = larger id" holds like on Telegram */
export const takeMessageId = (): number => (nextMessageId += 1);
