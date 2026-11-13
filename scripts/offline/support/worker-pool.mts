/**
 * The runner's side of a shared worker (worker/entry.mts): starts it, hands it
 * one test file at a time and turns each answer into the same FileRun a
 * process of its own would give.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import type { FileRun } from './run-file.mts';
import { connectWorker, type WorkerConnection, type WorkerConnectionOptions } from './worker-connection.mts';

/** Starting Node and tsx takes well under a second; this only catches a worker that hangs */
const READY_TIMEOUT_MS = 30_000;
/** How long an idle worker gets to end on its own before it is killed */
const STOP_GRACE_MS = 2_000;
/**
 * A worker keeps the module copies of every file it ran (about 9 MB each), so
 * it is replaced after this many files or this much memory.
 */
const MAX_FILES_PER_WORKER = 40;
const MAX_RESIDENT_MEGABYTES = 700;

export interface SharedWorkerOptions extends WorkerConnectionOptions {
    /** Files after which the worker is due for replacement; the default suits the real suite */
    maxFiles?: number;
    /** Resident memory from which the worker is due for replacement */
    maxResidentMegabytes?: number;
}

export interface WorkerFileRun extends FileRun {
    /**
     * false: the worker was gone before it took the file. The exit code is the
     * worker's and says nothing about the file.
     */
    started: boolean;
}

export interface SharedWorker {
    /** The files this worker has run, in order */
    readonly filesRun: readonly string[];
    /** false once the worker is gone or due for replacement: start another one */
    isUsable(): boolean;
    /** Resolves when the file has ended, or when the worker has (the file then has the worker's exit code) */
    run(file: string, logPath: string, timeoutMs: number): Promise<WorkerFileRun>;
    stop(): Promise<void>;
}

/** What the worker's answers add up to */
interface WorkerState {
    filesRun: string[];
    residentMegabytes: number;
    /** false once a file has left something in the worker that it could not undo */
    reusable: boolean;
}

/** Resolves with why the worker cannot be used, or with `undefined` when it is ready */
const waitUntilReady = (connection: WorkerConnection): Promise<string | undefined> =>
    new Promise((resolve) => {
        let timeout: NodeJS.Timeout | undefined;
        const settle = (unusable: string | undefined): void => {
            clearTimeout(timeout);
            connection.listen(undefined);
            resolve(unusable);
        };
        timeout = setTimeout(() => settle(`it was not ready after ${READY_TIMEOUT_MS / 1000} s`), READY_TIMEOUT_MS);
        connection.listen({
            onMessage: (message) => {
                if (message.kind !== 'ready') return;
                // The files would share module state, so they must run in processes of their own
                settle(message.freshModules ? undefined : 'its module hook has no effect');
            },
            onExit: (exitCode) => settle(`it ended with exit code ${exitCode ?? 'none'} before it was ready`),
        });
    });

interface FileToRun {
    file: string;
    logPath: string;
    timeoutMs: number;
    /** Named in the file's log when the worker never got to the file */
    workerLogPath: string;
}

const runFileIn = (connection: WorkerConnection, state: WorkerState, toRun: FileToRun): Promise<WorkerFileRun> =>
    new Promise((resolve) => {
        const { file, logPath } = toRun;
        const startedAt = performance.now();
        let timedOut = false;
        let started = false;
        // The worker appends to it. Created here: it is read even when the worker never gets that far.
        writeFileSync(logPath, '');
        const timeout = setTimeout(() => {
            timedOut = true;
            // Its exit follows and settles the run
            connection.end();
        }, toRun.timeoutMs);
        const settle = (exitCode: number | null): void => {
            clearTimeout(timeout);
            connection.listen(undefined);
            if (started) {
                state.filesRun.push(file);
            } else {
                appendFileSync(
                    logPath,
                    `[offline] the shared process ended before this file started (exit code ${exitCode ?? 'none'}); what it wrote last is in ${toRun.workerLogPath}\n`
                );
            }
            resolve({ file, logPath, exitCode, timedOut, started, durationMs: performance.now() - startedAt });
        };
        if (connection.hasExited()) {
            settle(null);
            return;
        }
        connection.listen({
            onMessage: (message) => {
                if (message.kind === 'started') started = true;
                if (message.kind !== 'done') return;
                state.residentMegabytes = message.residentMegabytes;
                state.reusable = message.reusable;
                settle(message.exitCode);
            },
            onExit: settle,
        });
        connection.send({ kind: 'run', file, logPath });
    });

const stopWorker = (connection: WorkerConnection): Promise<void> =>
    new Promise((resolve) => {
        if (connection.hasExited()) {
            resolve();
            return;
        }
        const timeout = setTimeout(connection.end, STOP_GRACE_MS);
        connection.listen({
            onMessage: () => undefined,
            onExit: () => {
                clearTimeout(timeout);
                resolve();
            },
        });
        // The worker ends itself when the channel closes
        if (!connection.disconnect()) connection.end();
    });

/**
 * Starts a worker and waits until it is ready. `undefined` when it cannot be
 * used; its log then says why.
 */
export const startSharedWorker = async (options: SharedWorkerOptions): Promise<SharedWorker | undefined> => {
    const connection = connectWorker(options);
    const unusable = await waitUntilReady(connection);
    if (unusable !== undefined) {
        connection.end();
        // By the runner: the worker may not have lived long enough to say anything
        const which = connection.processId === undefined ? 'the worker' : `process ${connection.processId}`;
        appendFileSync(options.logPath, `[offline] ${which} is not used: ${unusable}\n`);
        return undefined;
    }

    const state: WorkerState = { filesRun: [], residentMegabytes: 0, reusable: true };
    return {
        filesRun: state.filesRun,
        isUsable: () =>
            !connection.hasExited() &&
            state.reusable &&
            state.filesRun.length < (options.maxFiles ?? MAX_FILES_PER_WORKER) &&
            state.residentMegabytes < (options.maxResidentMegabytes ?? MAX_RESIDENT_MEGABYTES),
        run: (file, logPath, timeoutMs) =>
            runFileIn(connection, state, { file, logPath, timeoutMs, workerLogPath: options.logPath }),
        stop: () => stopWorker(connection),
    };
};
