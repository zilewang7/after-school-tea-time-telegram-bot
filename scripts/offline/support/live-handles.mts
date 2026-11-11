/**
 * Finds what keeps a finished test file running. The hook is only switched on
 * with OFFLINE_DEBUG_HANDLES=1: tracking every timer and handle slows a run down.
 */
import { createHook } from 'node:async_hooks';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** Short-lived bookkeeping resources that never keep a process alive on their own */
const IGNORED_TYPES = new Set(['PROMISE', 'TickObject', 'Microtask', 'Immediate']);

interface TrackedResource {
    type: string;
    /** Where it was created: the innermost frame inside the repository, outside node_modules */
    origin: string;
    /** The case that was running when it was created; '' before the first case */
    caseName: string;
    resource: WeakRef<object>;
}

const tracked = new Map<number, TrackedResource>();
/**
 * Where each async resource that is still around came from, the short-lived
 * ones included. A server or a socket is created by Node a tick after the
 * repository code that asked for it, with no frame of ours on its stack; what
 * asked for it is its trigger, so the origin is handed down from there.
 */
const origins = new Map<number, string>();
const UNKNOWN_ORIGIN = 'outside the repository';
/** Deep enough to reach the repository frame below a library's own calls */
const STACK_DEPTH = 50;
let currentCase = '';

/** Called by the harness as each case starts */
export const noteCaseStart = (name: string): void => {
    currentCase = name;
};

const originOf = (stack: string | undefined): string | undefined => {
    for (const line of (stack ?? '').split('\n').slice(1)) {
        const frame = /\(?(?:file:\/\/)?(\/[^():]+):(\d+):\d+\)?$/.exec(line.trim());
        const [, file, lineNumber] = frame ?? [];
        if (file === undefined || lineNumber === undefined) continue;
        if (!file.startsWith(REPOSITORY_ROOT) || file.includes('/node_modules/')) continue;
        if (file.endsWith('/support/live-handles.mts')) continue;
        return `${relative(REPOSITORY_ROOT, file)}:${lineNumber}`;
    }
    return undefined;
};

const currentOrigin = (): string | undefined => {
    const usualDepth = Error.stackTraceLimit;
    Error.stackTraceLimit = STACK_DEPTH;
    const stack = new Error().stack;
    Error.stackTraceLimit = usualDepth;
    return originOf(stack);
};

export const trackLiveHandles = (): void => {
    createHook({
        init(asyncId, type, triggerAsyncId, resource) {
            const origin = currentOrigin() ?? origins.get(triggerAsyncId);
            if (origin !== undefined) origins.set(asyncId, origin);
            if (IGNORED_TYPES.has(type)) return;
            tracked.set(asyncId, {
                type,
                origin: origin ?? UNKNOWN_ORIGIN,
                caseName: currentCase,
                resource: new WeakRef(resource),
            });
        },
        destroy(asyncId) {
            tracked.delete(asyncId);
            origins.delete(asyncId);
        },
    }).enable();
};

interface RefCounted {
    hasRef(): boolean;
}

const isRefCounted = (resource: object): resource is RefCounted =>
    'hasRef' in resource && typeof resource.hasRef === 'function';

/**
 * Whether the resource holds the process open: a timer or a handle (server,
 * socket, child process) that is still referenced. One that was unref'd
 * (`AbortSignal.timeout` does that) does not, and neither does a finished
 * request that only waits to be collected.
 */
const keepsProcessAlive = ({ resource }: TrackedResource): boolean => {
    const target = resource.deref();
    return target !== undefined && isRefCounted(target) && target.hasRef();
};

/** One line per place that created something still alive, most frequent first */
export const liveHandleOrigins = (): string[] => {
    const counts = new Map<string, number>();
    for (const entry of tracked.values()) {
        if (!keepsProcessAlive(entry)) continue;
        const during = entry.caseName === '' ? 'before the first case' : `during "${entry.caseName}"`;
        const key = `${entry.type} created at ${entry.origin} ${during}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts].sort((left, right) => right[1] - left[1]).map(([key, count]) => `${count}× ${key}`);
};
