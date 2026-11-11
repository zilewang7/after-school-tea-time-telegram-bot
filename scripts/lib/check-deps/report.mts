import type { Findings } from './analyze.mts';
import type { NewViolation } from './new-violations.mts';
import type { LinesByFile } from './violation.mts';

const totalLines = (linesByFile: LinesByFile): number =>
    [...linesByFile.values()].reduce((sum, lines) => sum + lines.length, 0);

/** The few lines a clean run prints */
export const formatSummary = (findings: Findings, seconds: number, parsedCount: number): string[] => [
    `check-deps: ${findings.fileCount} files (${parsedCount} parsed, the rest cached) in ${seconds.toFixed(2)} s`,
    `  static import cycles   ${findings.cycleCount} (${findings.importCycles.length} edges)`,
    `  upward imports         ${findings.upwardImports.length}`,
    `  index files with code  ${findings.indexFileCode.size}`,
    `  type assertions        ${totalLines(findings.typeAssertions)} in ${findings.typeAssertions.size} files`,
];

/** `path:line  what is wrong and what to do instead` */
export const formatViolation = (violation: NewViolation): string =>
    `${violation.path}:${violation.line}  ${violation.message}`;

export const formatFailureFooter = (count: number, baselinePath: string): string[] => [
    `check-deps: ${count} new violation(s) not covered by ${baselinePath}.`,
    'Fix them as described. The baseline entries of a moved or renamed file stay under its old path;',
    'only with the owner\'s approval, record the current state with `pnpm check-deps --accept`.',
];
