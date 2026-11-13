/**
 * Ends a test file's listeners on `process` the way the end of its own process
 * would: the 'exit' listeners run (files remove their temporary directories
 * there, the harness its database), every other listener it added is dropped.
 */

type Listener = ReturnType<typeof process.rawListeners>[number];
type ListenersByEvent = Map<string | symbol, readonly Listener[]>;

/** Raw: a `once` listener is found by the wrapper Node registered for it */
const currentListeners = (): ListenersByEvent =>
    new Map(process.eventNames().map((eventName) => [eventName, process.rawListeners(eventName)]));

let recorded: ListenersByEvent = new Map();

/** Once per worker, after the worker has added its own listeners */
export const recordListeners = (): void => {
    recorded = currentListeners();
};

/** Whether a listener for the event was added since `recordListeners` */
export const hasAddedListener = (eventName: string): boolean => {
    const kept = recorded.get(eventName) ?? [];
    return process.rawListeners(eventName).some((listener) => !kept.includes(listener));
};

/** Takes off what was added since `recordListeners`; returns the 'exit' listeners among it, in the order they were registered */
const removeAddedListeners = (): Listener[] => {
    const exitListeners: Listener[] = [];
    for (const [eventName, listeners] of currentListeners()) {
        const kept = recorded.get(eventName) ?? [];
        for (const listener of listeners) {
            if (kept.includes(listener)) continue;
            process.removeListener(eventName, listener);
            if (eventName === 'exit') exitListeners.push(listener);
        }
    }
    return exitListeners;
};

/**
 * Removes what was added since `recordListeners` and puts back what was
 * removed. The added 'exit' listeners are called with `exitCode`. When one of
 * them throws, so does this function: the caller ends the process, as Node
 * does, and the listeners after it never run.
 */
export const endFileListeners = (exitCode: number): void => {
    // All taken off before the first one runs: none may be left for the real end of the worker
    for (const listener of removeAddedListeners()) Reflect.apply(listener, process, [exitCode]);
    // A listener registered by one of them would never have been called
    removeAddedListeners();
    for (const [eventName, listeners] of recorded) {
        const now = process.rawListeners(eventName);
        for (const listener of listeners) {
            if (!now.includes(listener)) process.on(eventName, listener);
        }
    }
};
