/**
 * A shared worker: runs the test files the runner sends, one after the other,
 * in this one process.
 *
 * Every file gets its own copy of the repository's modules (fresh-modules.mts)
 * and ends the way its own process would end: when nothing it started keeps
 * the event loop busy. The worker then does what the end of a process does for
 * free (runs the 'exit' listeners, drops the file's pending timers, forgets
 * replaced globals and env values) and reports the exit code.
 *
 * Whatever really ends a process still ends this one: an uncaught error,
 * process.exit, the harness's limit on lingering. The runner takes the exit
 * code for the file that was running and starts another worker.
 *
 * Started by worker-pool.mts with an IPC channel; its own stdout and stderr
 * (what is written outside a file) go to the worker's log.
 */
import { closeSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { recordEnvironment, restoreEnvironment } from './environment.mts';
import { freshUrlOf, registerFreshModules } from './fresh-modules.mts';
import { recordGlobals, restoreGlobals } from './globals.mts';
import { endFileListeners, hasAddedListener, recordListeners } from './listeners.mts';
import { routeOutput, sendOutputTo, writeToLog } from './output.mts';
import { isRunFileMessage, type WorkerMessage } from './protocol.mts';
import { removeScratchDirectoryOf } from '../scratch-directory.mts';
import { clearLeftoverTimers, recordUnrefdTimers } from './timers.mts';

/** What Node ends a process with when its entry module never finishes */
const UNSETTLED_TOP_LEVEL_AWAIT = 13;
/** The worker's own exit code for a file it cannot run the way a process of its own would */
const NEEDS_ITS_OWN_PROCESS = 75;
const PROBE_PATH = fileURLToPath(new URL('./probe.mts', import.meta.url));

interface RunningFile {
    file: string;
    logDescriptor: number;
    /** The import of the file has finished: its top-level code ran to the end */
    evaluated: boolean;
}

const channel = process.channel;
if (channel === undefined || process.send === undefined) {
    console.error('worker/entry.mts is started by the offline runner, with an IPC channel');
    process.exit(2);
}
const send = (message: WorkerMessage): void => void process.send?.(message);

let running: RunningFile | undefined;
let generation = 0;

const stackOf = (error: unknown): string => (error instanceof Error ? (error.stack ?? error.message) : String(error));

const exitCodeSoFar = (): number => {
    const code = Number(process.exitCode ?? 0);
    return Number.isInteger(code) ? code : 1;
};

/** The file's process would be gone now: do what that would have done, then report */
const endRunningFile = (file: RunningFile): void => {
    running = undefined;
    try {
        endFileListeners(exitCodeSoFar());
    } catch (error) {
        // An 'exit' listener that throws ends its process with exit code 1
        writeToLog(`\nUncaught error: ${stackOf(error)}\n`);
        process.exit(1);
    }
    // Read after the listeners: they may still set it
    const exitCode = exitCodeSoFar();
    clearLeftoverTimers();
    const restored = restoreGlobals();
    restoreEnvironment();
    process.exitCode = undefined;
    sendOutputTo(undefined);
    closeSync(file.logDescriptor);
    // In the worker's own log: where to look when a later file fails only in a worker
    if (restored.length > 0) console.error(`[worker] ${file.file} had replaced: ${restored.join(', ')}`);
    // Waiting for the next file is the only thing that keeps the worker alive
    channel.ref();
    send({ kind: 'done', exitCode, residentMegabytes: Math.round(process.memoryUsage.rss() / (1024 * 1024)) });
};

const startFile = (file: string, logPath: string): void => {
    generation += 1;
    // The harness of the file before removed it when that file ended; what the
    // file left running may have written there since
    removeScratchDirectoryOf(process.pid);
    const started: RunningFile = { file, logDescriptor: openSync(logPath, 'a'), evaluated: false };
    running = started;
    sendOutputTo(started.logDescriptor);
    send({ kind: 'started' });
    // From here on only the file's own work keeps the event loop alive, so
    // 'beforeExit' tells when that work is done
    channel.unref();
    import(freshUrlOf(file, generation)).then(
        () => {
            started.evaluated = true;
        },
        (error: unknown) => {
            // In a process of its own this is an uncaught error: it ends the
            // process at once, whatever the file has left running
            writeToLog(`\n${stackOf(error)}\n`);
            process.exit(1);
        }
    );
};

// ---- once per worker, before the first file
// The switch exists for the test of what the runner does when the hook has no effect
if (process.env.OFFLINE_WORKER_HOOK !== 'off') registerFreshModules();
routeOutput();
recordUnrefdTimers();

const modulesAreFresh = async (): Promise<boolean> => {
    const [first, second]: { probeState: object }[] = await Promise.all([
        import(freshUrlOf(PROBE_PATH, 'probe1')),
        import(freshUrlOf(PROBE_PATH, 'probe2')),
    ]);
    return first !== undefined && second !== undefined && first.probeState !== second.probeState;
};
const freshModules = await modulesAreFresh();

// The error is printed by Node on the worker's own stderr; the file's log is
// where it will be looked for
process.on('uncaughtExceptionMonitor', (error, origin) => {
    if (running === undefined) return;
    const what = origin === 'unhandledRejection' ? 'Unhandled rejection' : 'Uncaught error';
    try {
        writeToLog(`\n${what}: ${stackOf(error)}\n`);
    } catch {
        // The error itself must reach Node, which ends the process over it
    }
});

process.on('beforeExit', () => {
    // Nothing is running: the runner is gone, and so is the reason to stay
    if (running === undefined) return;
    if (hasAddedListener('beforeExit')) {
        // The file's listener may start new work, and only Node can tell
        // whether it did. The runner runs the file again on its own.
        writeToLog("\n[offline] this file listens for 'beforeExit': it needs a process of its own\n");
        process.exit(NEEDS_ITS_OWN_PROCESS);
    }
    if (!running.evaluated) {
        writeToLog('\n[offline] the file never finished: its top-level await waits for something that cannot happen any more\n');
        // As Node does: a code the file has set itself stays
        process.exitCode ??= UNSETTLED_TOP_LEVEL_AWAIT;
    }
    endRunningFile(running);
});

// The runner is gone, or has let go of this worker: there is nobody to run a file for
process.on('disconnect', () => process.exit());

process.on('message', (message: unknown) => {
    if (running !== undefined || !isRunFileMessage(message)) return;
    startFile(message.file, message.logPath);
});

recordGlobals();
recordListeners();
recordEnvironment();
send({ kind: 'ready', freshModules });
