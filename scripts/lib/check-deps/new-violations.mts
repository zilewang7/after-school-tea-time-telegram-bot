import type { Findings } from './analyze.mts';
import type { Baseline } from './baseline.mts';
import type { KeyedViolation, LinesByFile } from './violation.mts';

/** A violation the baseline does not cover */
export interface NewViolation {
    path: string;
    line: number;
    message: string;
}

/** How a per-file count is described when it grew */
interface CountedRule {
    what: string;
    insteadAdvice: string;
}

const TYPE_ASSERTION_RULE: CountedRule = {
    what: 'type assertions (`as`)',
    insteadAdvice:
        'narrow with a type guard, annotate the variable, use `satisfies`, or build the value with its real type',
};

const INDEX_FILE_RULE: CountedRule = {
    what: 'statements in an index file that are not re-exports',
    insteadAdvice: 'move the code into a module of its own and re-export it from here',
};

/** Enough lines to find the new one without flooding the output */
const MAX_LISTED_LINES = 12;

const listLines = (lines: readonly number[]): string => {
    const listed = lines.slice(0, MAX_LISTED_LINES).join(', ');
    return lines.length > MAX_LISTED_LINES ? `${listed}, …` : listed;
};

const grownCounts = (linesByFile: LinesByFile, allowed: ReadonlyMap<string, number>, rule: CountedRule): NewViolation[] => {
    const violations: NewViolation[] = [];
    for (const [path, lines] of linesByFile) {
        const allowedCount = allowed.get(path) ?? 0;
        if (lines.length <= allowedCount) continue;
        violations.push({
            path,
            line: lines[0] ?? 1,
            message:
                `${rule.what} grew from ${allowedCount} to ${lines.length} ` +
                `(line${lines.length === 1 ? '' : 's'} ${listLines(lines)}); ${rule.insteadAdvice}`,
        });
    }
    return violations;
};

const uncovered = (violations: readonly KeyedViolation[], allowedKeys: readonly string[]): NewViolation[] => {
    const allowed = new Set(allowedKeys);
    return violations.filter((violation) => !allowed.has(violation.key));
};

const byLocation = (left: NewViolation, right: NewViolation): number =>
    left.path === right.path ? left.line - right.line : left.path < right.path ? -1 : 1;

/** Everything found that the baseline does not allow, ordered by file and line */
export const findNewViolations = (findings: Findings, baseline: Baseline): NewViolation[] =>
    [
        ...findings.unlistedEntries,
        ...uncovered(findings.importCycles, baseline.importCycles),
        ...uncovered(findings.upwardImports, baseline.upwardImports),
        ...grownCounts(findings.indexFileCode, baseline.indexFileCode, INDEX_FILE_RULE),
        ...grownCounts(findings.typeAssertions, baseline.typeAssertions, TYPE_ASSERTION_RULE),
    ]
        .map(({ path, line, message }) => ({ path, line, message }))
        .sort(byLocation);
