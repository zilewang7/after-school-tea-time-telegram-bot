/**
 * Puts back the global objects a test file replaced.
 *
 * A file may swap `fetch`, `Date.now`, a console method or `http.request` and
 * never restore it: its process ends anyway. In a shared worker the next file
 * would inherit the replacement. The worker therefore records the own
 * properties of the objects below once, before the first file, and compares
 * after every file.
 *
 * One kind of addition stays: a property under a symbol. That is how a package
 * keeps a single instance of something for all its copies (undici's global
 * dispatcher under Symbol.for('undici.globalDispatcher.1'), which cannot even
 * be deleted). It belongs to the package, which the files of a worker share
 * anyway, so it is kept and watched from then on like any other property.
 *
 * What cannot be put back (a file made the property non-configurable) stays in
 * the worker. The worker says so, and the runner gives the next file another one.
 */
import { syncBuiltinESMExports } from 'node:module';

interface WatchedObject {
    /** How the object is written in code: the prefix of what `restoreGlobals` reports */
    label: string;
    target: object;
    /** Only these properties; every own property when left out */
    keys?: readonly PropertyKey[];
}

/** The `node:` modules a test may replace a function of, to watch or to fake what goes through it */
const WATCHED_MODULES = [
    'node:child_process',
    'node:crypto',
    'node:dns',
    'node:fs',
    'node:fs/promises',
    'node:http',
    'node:https',
    'node:net',
    'node:os',
    'node:timers',
    'node:tls',
] as const;

const WATCHED: readonly WatchedObject[] = [
    { label: 'globalThis', target: globalThis },
    { label: 'console', target: console },
    { label: 'Date', target: Date },
    { label: 'Math', target: Math },
    { label: 'Error', target: Error },
    { label: 'process', target: process },
    // The streams themselves change as they are used; only who writes is watched
    { label: 'process.stdout', target: process.stdout, keys: ['write'] },
    { label: 'process.stderr', target: process.stderr, keys: ['write'] },
    // What `import http from 'node:http'` gives: the object replacements are made on
    ...WATCHED_MODULES.map((name) => ({ label: name, target: process.getBuiltinModule(name) })),
];

/** Node's own bookkeeping on `process` (`_events`, `_exiting`, …) changes without anyone replacing anything */
const isBookkeeping = (key: PropertyKey): boolean => typeof key === 'string' && key.startsWith('_');

type Descriptors = Map<PropertyKey, PropertyDescriptor>;

const descriptorsOf = ({ target, keys }: WatchedObject): Descriptors => {
    const descriptors: Descriptors = new Map();
    for (const key of keys ?? Reflect.ownKeys(target)) {
        if (isBookkeeping(key)) continue;
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (descriptor !== undefined) descriptors.set(key, descriptor);
    }
    return descriptors;
};

const sameDescriptor = (left: PropertyDescriptor, right: PropertyDescriptor): boolean =>
    Object.is(left.value, right.value) &&
    left.get === right.get &&
    left.set === right.set &&
    left.writable === right.writable &&
    left.enumerable === right.enumerable &&
    left.configurable === right.configurable;

let recorded: Map<WatchedObject, Descriptors> | undefined;

/** Once per worker, after the worker has installed its own replacements (output) */
export const recordGlobals = (): void => {
    // Replaces itself with its value when first read; read now, that is not a file's doing
    void process.allowedNodeEnvironmentFlags;
    recorded = new Map(WATCHED.map((watched) => [watched, descriptorsOf(watched)]));
};

const nameOf = (watched: WatchedObject, key: PropertyKey): string =>
    watched.label === 'globalThis' ? String(key) : `${watched.label}.${String(key)}`;

export interface RestoredGlobals {
    /** The properties that had changed and are as they were again */
    restored: string[];
    /** The properties that could not be put back or removed: they stay as the file left them */
    stuck: string[];
}

const restoreObject = (watched: WatchedObject, original: Descriptors): RestoredGlobals => {
    const restored: string[] = [];
    const stuck: string[] = [];
    const current = descriptorsOf(watched);
    for (const [key, descriptor] of original) {
        const now = current.get(key);
        if (now !== undefined && sameDescriptor(now, descriptor)) continue;
        if (Reflect.defineProperty(watched.target, key, descriptor)) restored.push(nameOf(watched, key));
        else stuck.push(nameOf(watched, key));
    }
    for (const [key, descriptor] of current) {
        if (original.has(key)) continue;
        if (typeof key === 'symbol') {
            // A package's own instance, created on first use: the baseline for later files
            original.set(key, descriptor);
        } else if (Reflect.deleteProperty(watched.target, key)) {
            restored.push(nameOf(watched, key));
        } else {
            stuck.push(nameOf(watched, key));
        }
    }
    return { restored, stuck };
};

/** Undoes what the last file changed, as far as that can be done */
export const restoreGlobals = (): RestoredGlobals => {
    const results = [...(recorded ?? [])].map(([watched, original]) => restoreObject(watched, original));
    const restored = results.flatMap((result) => result.restored);
    // `import { request } from 'node:http'` follows the module object only when told to
    if (restored.some((name) => name.startsWith('node:'))) syncBuiltinESMExports();
    return { restored, stuck: results.flatMap((result) => result.stuck) };
};
