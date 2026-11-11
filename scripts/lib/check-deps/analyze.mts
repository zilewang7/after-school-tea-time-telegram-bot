import type { FileFacts } from './file-facts.mts';
import { findImportCycles } from './import-cycles.mts';
import { buildImportGraph, isSrcFile } from './import-graph.mts';
import { findUnlistedEntries, findUpwardImports } from './layering.mts';
import type { KeyedViolation, LinesByFile } from './violation.mts';

/** Everything the rules found in one set of files, before the baseline is applied */
export interface Findings {
    fileCount: number;
    /** Groups of src/ files that import each other statically */
    cycleCount: number;
    importCycles: KeyedViolation[];
    upwardImports: KeyedViolation[];
    /** src/ entries without a layer; the baseline never covers these */
    unlistedEntries: KeyedViolation[];
    indexFileCode: LinesByFile;
    typeAssertions: LinesByFile;
}

/** Files with at least one line, keyed by path */
const nonEmpty = (factsByPath: ReadonlyMap<string, FileFacts>, pick: (facts: FileFacts) => number[]): Map<string, number[]> => {
    const result = new Map<string, number[]>();
    for (const [path, facts] of factsByPath) {
        const lines = pick(facts);
        if (lines.length > 0) result.set(path, lines);
    }
    return result;
};

/**
 * Runs every rule over the facts of a set of files (repository-relative
 * path → facts). Layering and cycles look at src/ only; the per-file rules at
 * every file. Needs no parser, so a run with a warm cache never loads one.
 */
export const analyzeFacts = (factsByPath: ReadonlyMap<string, FileFacts>): Findings => {
    const edges = buildImportGraph(factsByPath);
    const cycles = findImportCycles(edges);
    return {
        fileCount: factsByPath.size,
        cycleCount: cycles.cycleCount,
        importCycles: cycles.violations,
        upwardImports: findUpwardImports(edges),
        unlistedEntries: findUnlistedEntries([...factsByPath.keys()].filter(isSrcFile)),
        indexFileCode: nonEmpty(factsByPath, (facts) => facts.indexFileCode),
        typeAssertions: nonEmpty(factsByPath, (facts) => facts.typeAssertions),
    };
};
