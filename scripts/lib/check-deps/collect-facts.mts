import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { hashText, type CachedFacts } from './facts-cache.mts';
import type { FileFacts } from './file-facts.mts';

/** The analyzer's own sources: a change to any of them makes every cached fact stale */
const ANALYZER_DIRECTORY = 'scripts/lib/check-deps/';

/**
 * Identifies the analyzer: its own source texts plus the installed TypeScript
 * (pnpm puts the version in the real path), whose parser produces the facts.
 */
export const analyzerKeyOf = (sources: ReadonlyMap<string, string>): string => {
    const analyzerTexts = [...sources]
        .filter(([path]) => path.startsWith(ANALYZER_DIRECTORY))
        .map(([path, text]) => `${path}\n${text}`);
    const typescriptLocation = realpathSync(createRequire(import.meta.url).resolve('@typescript/typescript6'));
    return hashText([typescriptLocation, ...analyzerTexts].join('\n'));
};

export interface CollectedFacts {
    factsByPath: Map<string, FileFacts>;
    /** The cache content for the next run: exactly the files of this one */
    entries: Map<string, CachedFacts>;
    /** Files that missed the cache and were parsed */
    parsedCount: number;
}

/**
 * Facts for every source, from the cache where the text is unchanged. The
 * parser (and TypeScript with it) is loaded only when some file missed.
 */
export const collectFacts = async (
    sources: ReadonlyMap<string, string>,
    cached: ReadonlyMap<string, CachedFacts>,
): Promise<CollectedFacts> => {
    const factsByPath = new Map<string, FileFacts>();
    const entries = new Map<string, CachedFacts>();
    let factsOf: ((path: string, text: string) => FileFacts) | undefined;
    let parsedCount = 0;
    for (const [path, text] of sources) {
        const hash = hashText(text);
        const hit = cached.get(path);
        let facts = hit?.hash === hash ? hit.facts : undefined;
        if (facts === undefined) {
            factsOf ??= (await import('./file-facts.mts')).factsOf;
            facts = factsOf(path, text);
            parsedCount += 1;
        }
        factsByPath.set(path, facts);
        entries.set(path, { hash, facts });
    }
    return { factsByPath, entries, parsedCount };
};
