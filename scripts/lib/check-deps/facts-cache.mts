import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FileFacts } from './file-facts.mts';
import type { ModuleReference } from './module-references.mts';

/** The facts of one file, valid while its text hashes the same */
export interface CachedFacts {
    hash: string;
    facts: FileFacts;
}

export const hashText = (text: string): string => createHash('sha1').update(text).digest('hex');

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isLineList = (value: unknown): value is number[] =>
    Array.isArray(value) && value.every((line) => typeof line === 'number');

const isModuleReference = (value: unknown): value is ModuleReference =>
    isRecord(value) &&
    typeof value.specifier === 'string' &&
    typeof value.line === 'number' &&
    typeof value.dynamic === 'boolean';

const isFileFacts = (value: unknown): value is FileFacts =>
    isRecord(value) &&
    Array.isArray(value.references) &&
    value.references.every(isModuleReference) &&
    isLineList(value.indexFileCode) &&
    isLineList(value.typeAssertions);

const isCachedFacts = (value: unknown): value is CachedFacts =>
    isRecord(value) && typeof value.hash === 'string' && isFileFacts(value.facts);

/**
 * Cached facts by path. Empty when the file is missing, unreadable, or was
 * written by another version of the analyzer: a cache can only save time,
 * never change a result.
 */
export const readFactsCache = (cacheFile: string, analyzerKey: string): Map<string, CachedFacts> => {
    const entries = new Map<string, CachedFacts>();
    let document: unknown;
    try {
        document = JSON.parse(readFileSync(cacheFile, 'utf8'));
    } catch {
        return entries;
    }
    if (!isRecord(document) || document.analyzerKey !== analyzerKey || !isRecord(document.files)) return entries;
    for (const [path, entry] of Object.entries(document.files)) {
        if (isCachedFacts(entry)) entries.set(path, entry);
    }
    return entries;
};

/** Written to a temporary name and renamed: a parallel run never reads half a file */
export const writeFactsCache = (cacheFile: string, analyzerKey: string, entries: ReadonlyMap<string, CachedFacts>): void => {
    mkdirSync(dirname(cacheFile), { recursive: true });
    const temporaryFile = `${cacheFile}.${process.pid}.tmp`;
    writeFileSync(temporaryFile, JSON.stringify({ analyzerKey, files: Object.fromEntries(entries) }));
    renameSync(temporaryFile, cacheFile);
};
