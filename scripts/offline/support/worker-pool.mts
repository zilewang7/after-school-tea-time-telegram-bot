/**
 * The runner's side of a shared worker (worker/entry.mts): starts it, hands it
 * one test file at a time and turns each answer into the same FileRun a
 * process of its own would give.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, closeSync, openSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { endProcessGroup, trackProcessGroup } from './process-groups.mts';
import type { FileRun } from './run-file.mts';
import { isWorkerMessage, type RunFileMessage, type WorkerMessage } from './worker/protocol.mts';

const WORKER_ENTRY = fileURLToPath(new URL('./worker/entry.mts', import.meta.url));
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

export interface SharedWorkerOptions {
    repositoryRoot: string;
    /** Receives what the worker writes outside of a test file */
    logPath: string;
    environment: NodeJS.ProcessEnv;
    /** Files after which the worker is due for replacement; the default suits the real suite */
    maxFiles?: number;
}

export interface WorkerFileRun extends FileRun {
    /**
     * false: the worker was gone before it took the file. The exit code is the
     * worker's and says nothing about the file; something an earlier file left
     * running ended the worker between two files.
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

interface WorkerEvents {
    onMessage: (message: WorkerMessage) => void;
    onExit: (exitCode: number | null) => void;
}

const NO_EVENTS: WorkerEvents = { onMessage: () => undefined, onExit: () => undefined };

const spawnWorker = (options: SharedWorkerOptions): ChildProcess => {
    const logDescriptor = openSync(options.logPath, 'a');
    const child = spawn(process.execPath, ['--import', 'tsx', WORKER_ENTRY], {
        cwd: options.repositoryRoot,
        env: options.environment,
        detached: true,
        stdio: ['ignore', logDescriptor, logDescriptor, 'ipc'],
    });
    closeSync(logDescriptor);
    return child;
};

/**
 * Starts a worker and waits until it is ready. `undefined` when it cannot be
 * used: it did not start, or its module hook does not take effect (the files
 * would share module state, so they must run in processes of their own).
 */
export const startSharedWorker = async (options: SharedWorkerOptions): Promise<SharedWorker | undefined> => {
    const child = spawnWorker(options);
    const groupId = child.pid;
    if (groupId !== undefined) trackProcessGroup(groupId);

    let exited = false;
    let events = NO_EVENTS;
    const filesRun: string[] = [];
    let residentMegabytes = 0;

    const end = (): void => {
        if (groupId !== undefined) endProcessGroup(groupId);
    };
    const noteExit = (exitCode: number | null): void => {
        if (exited) return;
        exited = true;
        // Whatever the worker left running or on disk goes with it
        end();
        events.onExit(exitCode);
    };
    child.on('message', (message: unknown) => {
        if (isWorkerMessage(message)) events.onMessage(message);
    });
    // Also a message that could not be sent because the worker is gone; more than one may follow
    child.on('error', () => noteExit(null));
    child.once('exit', noteExit);

    const ready = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), READY_TIMEOUT_MS);
        const settle = (usable: boolean): void => {
            clearTimeout(timeout);
            events = NO_EVENTS;
            resolve(usable);
        };
        events = {
            onMessage: (message) => {
                if (message.kind === 'ready') settle(message.freshModules);
            },
            onExit: () => settle(false),
        };
    });
    if (!ready) {
        end();
        return undefined;
    }

    const run = (file: string, logPath: string, timeoutMs: number): Promise<WorkerFileRun> =>
        new Promise((resolve) => {
            const startedAt = performance.now();
            let timedOut = false;
            let started = false;
            // The worker appends to it. Created here: it is read even when the worker never gets that far.
            writeFileSync(logPath, '');
            const timeout = setTimeout(() => {
                timedOut = true;
                // Its 'exit' follows and settles the run
                end();
            }, timeoutMs);
            const settle = (exitCode: number | null): void => {
                clearTimeout(timeout);
                events = NO_EVENTS;
                if (started) {
                    filesRun.push(file);
                } else {
                    appendFileSync(
                        logPath,
                        `[offline] the shared process ended before this file started (exit code ${exitCode ?? 'none'}); what it wrote last is in ${options.logPath}\n`
                    );
                }
                resolve({ file, logPath, exitCode, timedOut, started, durationMs: performance.now() - startedAt });
            };
            if (exited) {
                settle(null);
                return;
            }
            events = {
                onMessage: (message) => {
                    if (message.kind === 'started') started = true;
                    if (message.kind !== 'done') return;
                    residentMegabytes = message.residentMegabytes;
                    settle(message.exitCode);
                },
                onExit: settle,
            };
            const request: RunFileMessage = { kind: 'run', file, logPath };
            child.send(request);
        });

    const stop = (): Promise<void> =>
        new Promise((resolve) => {
            if (exited) {
                resolve();
                return;
            }
            const timeout = setTimeout(end, STOP_GRACE_MS);
            events = {
                onMessage: () => undefined,
                onExit: () => {
                    clearTimeout(timeout);
                    resolve();
                },
            };
            // The worker ends itself when the channel closes
            if (child.connected) child.disconnect();
            else end();
        });

    return {
        filesRun,
        isUsable: () =>
            !exited &&
            filesRun.length < (options.maxFiles ?? MAX_FILES_PER_WORKER) &&
            residentMegabytes < MAX_RESIDENT_MEGABYTES,
        run,
        stop,
    };
};
