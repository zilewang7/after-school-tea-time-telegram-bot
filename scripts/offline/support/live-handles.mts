/**
 * Finds what keeps a finished test file running. Only loaded with
 * OFFLINE_DEBUG_HANDLES=1: tracking every timer and handle slows a run down.
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
let currentCase = '';

/** Called by the harness as each case starts */
export const noteCaseStart = (name: string): void => {
    currentCase = name;
};

const originOf = (stack: string | undefined): string => {
    for (const line of (stack ?? '').split('\n').slice(1)) {
        const frame = /\(?(?:file:\/\/)?(\/[^():]+):(\d+):\d+\)?$/.exec(line.trim());
        const [, file, lineNumber] = frame ?? [];
        if (file === undefined || lineNumber === undefined) continue;
        if (!file.startsWith(REPOSITORY_ROOT) || file.includes('/node_modules/')) continue;
        if (file.endsWith('/support/live-handles.mts')) continue;
        return `${relative(REPOSITORY_ROOT, file)}:${lineNumber}`;
    }
    return 'outside the repository';
};

export const trackLiveHandles = (): void => {
    createHook({
        init(asyncId, type, _triggerAsyncId, resource) {
            if (IGNORED_TYPES.has(type)) return;
            tracked.set(asyncId, {
                type,
                origin: originOf(new Error().stack),
                caseName: currentCase,
                resource: new WeakRef(resource),
            });
        },
        destroy(asyncId) {
            tracked.delete(asyncId);
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
