import type { Findings } from './analyze.mts';
import { compareText, type LinesByFile } from './violation.mts';

/** The violations that existed when the guard was introduced or last accepted */
export interface Baseline {
    /** `from -> to` edges inside a static import cycle */
    importCycles: readonly string[];
    /** `from -> to` imports from a lower layer into a higher one */
    upwardImports: readonly string[];
    /** Statements other than re-exports, per index file */
    indexFileCode: ReadonlyMap<string, number>;
    /** Type assertions per file */
    typeAssertions: ReadonlyMap<string, number>;
}

const ABOUT =
    'Violations that existed when the guard was introduced. Remove entries that are fixed with ' +
    '`pnpm check-deps --tighten`; adding entries (`pnpm check-deps --accept`) needs the owner\'s approval.';

export const EMPTY_BASELINE: Baseline = {
    importCycles: [],
    upwardImports: [],
    indexFileCode: new Map(),
    typeAssertions: new Map(),
};

const countsOf = (linesByFile: LinesByFile): Map<string, number> =>
    new Map([...linesByFile].map(([path, lines]) => [path, lines.length] as const));

/** The baseline that covers exactly the current findings */
export const baselineOf = (findings: Findings): Baseline => ({
    importCycles: findings.importCycles.map((violation) => violation.key),
    upwardImports: findings.upwardImports.map((violation) => violation.key),
    indexFileCode: countsOf(findings.indexFileCode),
    typeAssertions: countsOf(findings.typeAssertions),
});

const sortedKeys = (keys: readonly string[]): string[] => [...new Set(keys)].sort(compareText);

const sortedCounts = (counts: ReadonlyMap<string, number>): Record<string, number> =>
    Object.fromEntries([...counts].filter(([, count]) => count > 0).sort(([left], [right]) => compareText(left, right)));

/** Sorted, one entry per line: two branches that each fix something merge cleanly */
export const serializeBaseline = (baseline: Baseline): string =>
    `${JSON.stringify(
        {
            about: ABOUT,
            importCycles: sortedKeys(baseline.importCycles),
            upwardImports: sortedKeys(baseline.upwardImports),
            indexFileCode: sortedCounts(baseline.indexFileCode),
            typeAssertions: sortedCounts(baseline.typeAssertions),
        },
        null,
        2,
    )}\n`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const readKeys = (document: Record<string, unknown>, field: string): string[] => {
    const value = document[field];
    if (value === undefined) return [];
    const entries: unknown[] = Array.isArray(value) ? value : [];
    const keys = entries.filter((entry): entry is string => typeof entry === 'string');
    if (!Array.isArray(value) || keys.length !== entries.length) {
        throw new Error(`baseline field "${field}" must be a list of strings`);
    }
    return [...new Set(keys)];
};

const readCounts = (document: Record<string, unknown>, field: string): Map<string, number> => {
    const value = document[field];
    if (value === undefined) return new Map();
    if (!isRecord(value)) throw new Error(`baseline field "${field}" must map file paths to counts`);
    const counts = new Map<string, number>();
    for (const [path, count] of Object.entries(value)) {
        if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
            throw new Error(`baseline field "${field}" has a bad count for ${path}`);
        }
        counts.set(path, count);
    }
    return counts;
};

/** Reads a baseline file; a field that is missing counts as empty */
export const parseBaseline = (text: string): Baseline => {
    const document: unknown = JSON.parse(text);
    if (!isRecord(document)) throw new Error('baseline must be a JSON object');
    return {
        importCycles: readKeys(document, 'importCycles'),
        upwardImports: readKeys(document, 'upwardImports'),
        indexFileCode: readCounts(document, 'indexFileCode'),
        typeAssertions: readCounts(document, 'typeAssertions'),
    };
};
