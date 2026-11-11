import { posix } from 'node:path';

/** What a written specifier may stand for, in the order the compiler tries them */
const candidatesFor = (target: string): string[] => {
    if (target.endsWith('.js')) return [target.replace(/\.js$/, '.ts'), target.replace(/\.js$/, '.tsx'), target];
    if (target.endsWith('.mjs')) return [target.replace(/\.mjs$/, '.mts'), target];
    if (/\.(ts|tsx|mts|cts|json)$/.test(target)) return [target];
    return [`${target}.ts`, `${target}.tsx`, `${target}/index.ts`, `${target}/index.tsx`];
};

/**
 * The repository-relative file a relative specifier points at, looked up in
 * the set of known files. Package imports and unknown files give undefined.
 */
export const resolveImport = (fromPath: string, specifier: string, knownFiles: ReadonlySet<string>): string | undefined => {
    if (!specifier.startsWith('.')) return undefined;
    const target = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
    return candidatesFor(target).find((candidate) => knownFiles.has(candidate));
};
