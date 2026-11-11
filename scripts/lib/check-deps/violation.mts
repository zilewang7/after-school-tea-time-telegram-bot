/** A violation the baseline records by its key, e.g. one import edge `a -> b` */
export interface KeyedViolation {
    key: string;
    path: string;
    line: number;
    /** What is wrong and what to do instead */
    message: string;
}

/** Lines per file of something the baseline counts per file */
export type LinesByFile = ReadonlyMap<string, readonly number[]>;

export const edgeKey = (from: string, to: string): string => `${from} -> ${to}`;

/** Code-unit order: the same on every machine, unlike localeCompare */
export const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** One violation per key (a file importing the same module twice is one edge), sorted by key */
export const uniqueByKey = (violations: readonly KeyedViolation[]): KeyedViolation[] => {
    const byKey = new Map<string, KeyedViolation>();
    for (const violation of violations) {
        if (!byKey.has(violation.key)) byKey.set(violation.key, violation);
    }
    return [...byKey.values()].sort((left, right) => compareText(left.key, right.key));
};
