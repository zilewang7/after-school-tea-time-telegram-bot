/**
 * Tells whether a call came from the repository's own code or from a package.
 *
 * It is the line fresh-modules.mts draws. The repository's code gets a fresh
 * copy with every test file, so what it started ends with the file. A package
 * is loaded once per worker and goes on using what it started.
 */

/** Enough to get past Node's own frames, whatever limit a file has set for its own stacks */
const FRAMES_KEPT = 30;

// What the worker started with: a file may replace either
const captureStackTrace = Error.captureStackTrace;
const prepareStackTrace = Error.prepareStackTrace;

export interface CallOrigin {
    /** Filled in by V8. Turned into text when first read, which is the costly part. */
    stack?: unknown;
}

/** Records where `calledFunction` was called from. Cheap as long as `isOfRepository` is not asked. */
export const captureCallOrigin = (calledFunction: (...parameters: never[]) => unknown): CallOrigin => {
    const origin: CallOrigin = {};
    const limit = Error.stackTraceLimit;
    // Not by assignment, here and below: that throws once a file has made the property read-only
    const raised = Reflect.set(Error, 'stackTraceLimit', FRAMES_KEPT);
    captureStackTrace(origin, calledFunction);
    if (raised) Reflect.set(Error, 'stackTraceLimit', limit);
    return origin;
};

/** Where a stack line points: a path, or `node:…` for Node's own code */
const FRAME_LOCATION = /\(?((?:file:\/\/)?\/[^():]+|node:[^():]+):\d+:\d+\)?$/;

/** The stack is formatted when it is read, by the Error.prepareStackTrace of that moment: the file's must not do it */
const stackTextOf = (origin: CallOrigin): unknown => {
    const ofTheFile = Error.prepareStackTrace;
    const swapped = Reflect.set(Error, 'prepareStackTrace', prepareStackTrace);
    try {
        return origin.stack;
    } catch {
        // The file's function formats it after all, and throws: nothing to go by
        return undefined;
    } finally {
        if (swapped) Reflect.set(Error, 'prepareStackTrace', ofTheFile);
    }
};

/**
 * The first frame outside Node's own code decides. The packages Node carries
 * inside (its undici, behind `fetch`) count as packages.
 */
export const isOfRepository = (origin: CallOrigin): boolean => {
    const stack = stackTextOf(origin);
    if (typeof stack !== 'string') return false;
    for (const line of stack.split('\n').slice(1)) {
        const location = FRAME_LOCATION.exec(line.trim())?.[1];
        if (location === undefined) continue;
        if (location.startsWith('node:internal/deps/')) return false;
        if (location.startsWith('node:')) continue;
        return !location.includes('/node_modules/');
    }
    // Node did it for itself
    return false;
};
