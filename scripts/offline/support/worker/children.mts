/**
 * Ends the child processes a test file leaves running.
 *
 * A file has ended when nothing keeps the event loop busy, so a child that is
 * still running then was unref'd. In a process of its own it does not outlive
 * the file: the runner ends the whole process group. In a shared worker it
 * would go on working during a later file.
 *
 * Only the children the repository's own code started are ended, for the
 * reason timers.mts gives: a package goes on using the helper it started. And
 * not a detached one, which leads a group of its own and outlives a process of
 * its own just the same.
 */
import { ChildProcess } from 'node:child_process';
import { captureCallOrigin, isOfRepository, type CallOrigin } from './call-origin.mts';

interface StartedChild {
    child: ChildProcess;
    startedAt: CallOrigin;
}

let startedChildren: StartedChild[] = [];

const isDetached = (spawnOptions: unknown): boolean =>
    typeof spawnOptions === 'object' && spawnOptions !== null && 'detached' in spawnOptions && spawnOptions.detached === true;

/**
 * Once per worker, before any package is loaded. Every way of starting a child
 * that can be left running (spawn, exec, execFile, fork) goes through this one
 * method, which the types do not show.
 */
export const recordStartedChildren = (): void => {
    const prototype: object = ChildProcess.prototype;
    const spawn: unknown = Reflect.get(prototype, 'spawn');
    // A Node that starts them another way: nothing is recorded, and nothing ended
    if (typeof spawn !== 'function') return;
    Reflect.set(prototype, 'spawn', function recordingSpawn(this: ChildProcess, ...parameters: unknown[]): unknown {
        if (!isDetached(parameters[0])) {
            startedChildren.push({ child: this, startedAt: captureCallOrigin(recordingSpawn) });
        }
        return Reflect.apply(spawn, this, parameters);
    });
};

const isRunning = (child: ChildProcess): boolean =>
    child.pid !== undefined && child.exitCode === null && child.signalCode === null;

/**
 * Ends the recorded children of the repository's code that still run, and
 * returns how many. Each of them keeps the event loop busy from now until it
 * is gone, so 'beforeExit' comes again once what their end sets off (their
 * 'exit' listeners) has run as well.
 */
export const endLeftoverChildren = (): number => {
    let ended = 0;
    for (const { child, startedAt } of startedChildren) {
        if (!isRunning(child) || !isOfRepository(startedAt)) continue;
        if (!child.kill('SIGKILL')) continue;
        child.ref();
        ended += 1;
    }
    startedChildren = [];
    return ended;
};
