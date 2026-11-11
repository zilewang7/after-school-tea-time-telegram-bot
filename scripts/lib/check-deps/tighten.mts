import type { Findings } from './analyze.mts';
import type { Baseline } from './baseline.mts';
import type { KeyedViolation, LinesByFile } from './violation.mts';

export interface Tightening {
    /** The baseline without what no longer occurs; never wider than before */
    baseline: Baseline;
    /** One line per kind of change, e.g. "2 upward imports gone"; empty when nothing changed */
    changes: string[];
}

const keepOccurring = (allowedKeys: readonly string[], violations: readonly KeyedViolation[]): string[] => {
    const current = new Set(violations.map((violation) => violation.key));
    return allowedKeys.filter((key) => current.has(key));
};

/** Each count lowered to what the file has now; files at zero drop out */
const lowerCounts = (allowed: ReadonlyMap<string, number>, linesByFile: LinesByFile): Map<string, number> => {
    const lowered = new Map<string, number>();
    for (const [path, allowedCount] of allowed) {
        const count = Math.min(allowedCount, linesByFile.get(path)?.length ?? 0);
        if (count > 0) lowered.set(path, count);
    }
    return lowered;
};

const loweredFileCount = (before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>): number =>
    [...before].filter(([path, count]) => (after.get(path) ?? 0) < count).length;

const describeChanges = (before: Baseline, after: Baseline): string[] => {
    const changes: string[] = [];
    const goneCycleEdges = before.importCycles.length - after.importCycles.length;
    const goneUpwardImports = before.upwardImports.length - after.upwardImports.length;
    const lowerIndexFiles = loweredFileCount(before.indexFileCode, after.indexFileCode);
    const lowerAssertionFiles = loweredFileCount(before.typeAssertions, after.typeAssertions);
    if (goneCycleEdges > 0) changes.push(`${goneCycleEdges} import cycle edge(s) gone`);
    if (goneUpwardImports > 0) changes.push(`${goneUpwardImports} upward import(s) gone`);
    if (lowerIndexFiles > 0) changes.push(`less code in ${lowerIndexFiles} index file(s)`);
    if (lowerAssertionFiles > 0) changes.push(`fewer type assertions in ${lowerAssertionFiles} file(s)`);
    return changes;
};

/**
 * The ratchet: drop baseline entries that no longer occur and lower counts
 * that went down. New violations are never added here.
 */
export const tightenBaseline = (baseline: Baseline, findings: Findings): Tightening => {
    const tightened: Baseline = {
        importCycles: keepOccurring(baseline.importCycles, findings.importCycles),
        upwardImports: keepOccurring(baseline.upwardImports, findings.upwardImports),
        indexFileCode: lowerCounts(baseline.indexFileCode, findings.indexFileCode),
        typeAssertions: lowerCounts(baseline.typeAssertions, findings.typeAssertions),
    };
    return { baseline: tightened, changes: describeChanges(baseline, tightened) };
};
