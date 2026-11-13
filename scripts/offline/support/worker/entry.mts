/**
 * A shared worker: runs the test files the runner sends, one after the other,
 * in this one process.
 *
 * Every file gets its own copy of the repository's modules (fresh-modules.mts)
 * and ends the way its own process would end: when nothing it started keeps
 * the event loop busy. The worker then does what the end of a process does for
 * free, in two steps:
 *
 * 1. The file's 'exit' listeners run and decide the exit code, and the
 *    children it left running are ended.
 * 2. When whatever that set off has ended as well, the worker is put back to
 *    how it started (timers, globals, listeners, environment) and reports the
 *    exit code. A real exit would have cut that work off; here it must at
 *    least not run into the next file.
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
import { inspect } from 'node:util';
import { endLeftoverChildren, recordStartedChildren } from './children.mts';
import { recordEnvironment, restoreEnvironment, setArgumentsOf } from './environment.mts';
import { freshUrlOf, registerFreshModules } from './fresh-modules.mts';
import { recordGlobals, restoreGlobals } from './globals.mts';
import { hasAddedListener, recordListeners, restoreListeners, runExitListeners } from './listeners.mts';
import { routeOutput, sendOutputTo, writeToLog } from './output.mts';
import { isRunFileMessage, type WorkerMessage } from './protocol.mts';
import { removeScratchDirectoryOf } from '../scratch-directory.mts';
import { clearLeftoverTimers, recordUnrefdTimers } from './timers.mts';

/** What Node ends a process with when its entry module never finishes */
const UNSETTLED_TOP_LEVEL_AWAIT = 13;
/** The worker's own exit code for a file it cannot run the way a process of its own would */
const NEEDS_ITS_OWN_PROCESS = 75;
/** A process ends with the low eight bits of its exit code */
const EXIT_STATUS_BITS = 0xff;
const PROBE_PATH = fileURLToPath(new URL('./probe.mts', import.meta.url));

// The worker's own references: a file may leave a stub in place of either
const exitWorker = process.exit.bind(process);
const runAnotherTurn = setImmediate;

interface RunningFile {
    file: string;
    logDescriptor: number;
    /** The import of the file has finished: its top-level code ran to the end */
    evaluated: boolean;
    /** What its process would have exited with. Set by step 1, when its 'exit' listeners have run. */
    exitCode: number | undefined;
}

const channel = process.channel;
if (channel === undefined || process.send === undefined) {
    console.error('worker/entry.mts is started by the offline runner, with an IPC channel');
    process.exit(2);
}
const send = (message: WorkerMessage): void => void process.send?.(message);

let running: RunningFile | undefined;
let generation = 0;

const stackOf = (error: unknown): string => (error instanceof Error ? (error.stack ?? error.message) : inspect(error));

/** As the file has set it so far, and what its 'exit' listeners are called with */
const exitCodeSoFar = (): number => {
    const code = Number(process.exitCode ?? 0);
    return Number.isInteger(code) ? code : 1;
};

/** Step 1: what the end of the file's process would have run */
const endFile = (file: RunningFile): void => {
    try {
        runExitListeners(exitCodeSoFar());
    } catch (error) {
        // An 'exit' listener that throws ends its process with exit code 1
        writeToLog(`\nUncaught error: ${stackOf(error)}\n`);
        exitWorker(1);
    }
    // Read after the listeners: they may still set it
    file.exitCode = exitCodeSoFar() & EXIT_STATUS_BITS;
    endLeftoverChildren();
    // The listeners may have started work, and the end of a child sets off
    // its own. All of it runs while the worker still belongs to this file:
    // one more turn of the event loop at least, then 'beforeExit' comes again.
    runAnotherTurn(() => undefined);
};

/** Step 2: the worker as the next file must find it, and the report to the runner */
const releaseWorker = (file: RunningFile, exitCode: number): void => {
    running = undefined;
    clearLeftoverTimers();
    const { restored, stuck } = restoreGlobals();
    // Node keeps it inside, so it is not among the globals. With it in place a
    // later file's uncaught error would go to this file's callback and not end the process.
    if (process.hasUncaughtExceptionCaptureCallback()) {
        process.setUncaughtExceptionCaptureCallback(null);
        restored.push('the callback for uncaught exceptions');
    }
    restoreListeners();
    restoreEnvironment();
    process.exitCode = undefined;
    sendOutputTo(undefined);
    closeSync(file.logDescriptor);
    // In the worker's own log: where to look when a later file fails only in a worker
    if (restored.length > 0) console.error(`[worker] ${file.file} had replaced: ${restored.join(', ')}`);
    if (stuck.length > 0) {
        console.error(`[worker] ${file.file} left what cannot be undone, the next file gets another worker: ${stuck.join(', ')}`);
    }
    // Waiting for the next file is the only thing that keeps the worker alive
    channel.ref();
    send({
        kind: 'done',
        exitCode,
        residentMegabytes: Math.round(process.memoryUsage.rss() / (1024 * 1024)),
        reusable: stuck.length === 0,
    });
};

const startFile = (file: string, logPath: string): void => {
    generation += 1;
    // The harness of the file before removed it when that file ended; what the
    // file's 'exit' listeners did after that may have written there again
    removeScratchDirectoryOf(process.pid);
    const started: RunningFile = { file, logDescriptor: openSync(logPath, 'a'), evaluated: false, exitCode: undefined };
    running = started;
    setArgumentsOf(file);
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
            exitWorker(1);
        }
    );
};

// ---- once per worker, before the first file
// The switch exists for the test of what the runner does when the hook has no effect
if (process.env.OFFLINE_WORKER_HOOK !== 'off') registerFreshModules();
routeOutput();
recordUnrefdTimers();
recordStartedChildren();

const modulesAreFresh = async (): Promise<boolean> => {
    const [first, second]: { probeState: object }[] = await Promise.all([
        import(freshUrlOf(PROBE_PATH, 'probe1')),
        import(freshUrlOf(PROBE_PATH, 'probe2')),
    ]);
    return first !== undefined && second !== undefined && first.probeState !== second.probeState;
};
const freshModules = await modulesAreFresh();
if (!freshModules) {
    console.error('[worker] the module hook has no effect here: two imports of one module gave the same instance');
}

// undici keeps its dispatcher in a slot on globalThis that it shares with the
// copy inside Node (behind `fetch`). Whichever loads first fills the slot, and
// the package replaces what an older copy inside Node (Node 24) has put there.
// Loaded now, the slot is settled before the first file. Loaded by a file, the
// change would look like something that file replaced and be undone, for a
// package that is never loaded again.
await import('undici').catch(() => undefined);

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
        exitWorker(NEEDS_ITS_OWN_PROCESS);
    }
    if (running.exitCode !== undefined) {
        // A child started since step 1 holds the worker until it is gone too
        if (endLeftoverChildren() === 0) releaseWorker(running, running.exitCode);
        return;
    }
    if (!running.evaluated) {
        writeToLog('\n[offline] the file never finished: its top-level await waits for something that cannot happen any more\n');
        // As Node does: only a code other than 0 that the file has set itself stays
        if (exitCodeSoFar() === 0) process.exitCode = UNSETTLED_TOP_LEVEL_AWAIT;
    }
    endFile(running);
});

const endOwnProcessGroup = (): void => {
    try {
        process.kill(-process.pid, 'SIGKILL');
    } catch {
        // Started by hand, not by the runner: this process leads no group
    }
};

// The runner is gone, or has let go of this worker: there is nobody to run a
// file for. What a file in progress has started must not stay behind either,
// and the runner, which ends the group otherwise, may be what is gone. Added
// only now, so it is the last 'exit' listener: it ends this process too.
process.on('disconnect', () => {
    process.on('exit', endOwnProcessGroup);
    exitWorker();
});

process.on('message', (message: unknown) => {
    if (running !== undefined || !isRunFileMessage(message)) return;
    startFile(message.file, message.logPath);
});

recordGlobals();
recordListeners();
recordEnvironment();
console.error(`[worker] process ${process.pid} is ready`);
send({ kind: 'ready', freshModules });
