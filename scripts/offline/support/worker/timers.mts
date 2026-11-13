/**
 * Clears the timers a test file leaves behind.
 *
 * A file has ended when nothing keeps the event loop busy, so a timer that is
 * still pending then was unref'd: the harness's limit on lingering, an
 * interval of `src`, an AbortSignal.timeout. In a process of its own it
 * disappears with the process. In a shared worker it would fire in the middle
 * of a later file.
 *
 * Only the timers of the repository's own code are cleared. A package is
 * loaded once per worker and goes on using its timers: undici drives all its
 * timeouts from one timer, which never starts again once it was cleared.
 */
import { captureCallOrigin, isOfRepository, type CallOrigin } from './call-origin.mts';

/** Past this many entries the timers that are gone are dropped from the list */
const PRUNE_ABOVE = 10_000;

// The worker's own reference: a file may leave a fake in place of the global
const clearTimer = clearTimeout;

interface UnrefdTimer {
    /** Weak: a timer that fired and that nobody holds any more need not be kept */
    timer: WeakRef<NodeJS.Timeout>;
    unrefdAt: CallOrigin;
}

let unrefdTimers: UnrefdTimer[] = [];
let pruneAbove = PRUNE_ABOVE;

/**
 * Once per worker, before any package is loaded. Recording at `unref` and not
 * at `setTimeout` reaches the timers Node creates with its own reference to
 * setTimeout (AbortSignal.timeout) and costs nothing for all the others.
 */
export const recordUnrefdTimers = (): void => {
    const sample = setTimeout(() => undefined, 0);
    clearTimeout(sample);
    const prototype: { unref: (this: NodeJS.Timeout) => NodeJS.Timeout } = Object.getPrototypeOf(sample);
    const unref = prototype.unref;
    prototype.unref = function recordingUnref(this: NodeJS.Timeout): NodeJS.Timeout {
        if (unrefdTimers.length >= pruneAbove) {
            unrefdTimers = unrefdTimers.filter((entry) => entry.timer.deref() !== undefined);
            // Not again before the list has grown by as much as is still in use
            pruneAbove = Math.max(PRUNE_ABOVE, unrefdTimers.length * 2);
        }
        unrefdTimers.push({ timer: new WeakRef(this), unrefdAt: captureCallOrigin(recordingUnref) });
        return Reflect.apply(unref, this, []);
    };
};

/** Clears the recorded timers of the repository's code; clearing one that has fired is harmless */
export const clearLeftoverTimers = (): void => {
    for (const { timer, unrefdAt } of unrefdTimers) {
        const leftover = timer.deref();
        if (leftover !== undefined && isOfRepository(unrefdAt)) clearTimer(leftover);
    }
    unrefdTimers = [];
    pruneAbove = PRUNE_ABOVE;
};
