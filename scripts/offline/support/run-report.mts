/**
 * Turns the log of one test file into what the runner prints about it.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { FileRun } from './run-file.mts';

export interface FailedCase {
    name: string;
    message: string;
    /** `path:line` of the failing assertion, when the harness printed one */
    location: string | undefined;
}

export interface FileReport {
    run: FileRun;
    /** File name without the extension */
    name: string;
    passedCases: number;
    failedCases: FailedCase[];
    /** The file ended without printing a summary: it crashed or was killed */
    incomplete: boolean;
    /** The last lines of the log, shown when there is no summary to go by */
    logTail: string[];
    ok: boolean;
}

const SUMMARY_MARKER = '==== offline summary ====';
const LOG_TAIL_LINES = 25;

/**
 * The failures the harness printed while the cases ran. A file that runs its
 * cases concurrently can attribute one to the wrong case; the summary below
 * stays the source of truth for which cases failed.
 */
const collectFailureDetails = (lines: string[]): Map<string, FailedCase> => {
    const details = new Map<string, FailedCase>();
    let currentCase = '';
    lines.forEach((line, index) => {
        if (line.startsWith('▶ ')) {
            currentCase = line.slice(2);
            return;
        }
        const failure = /^\s+✗ (.*)$/.exec(line);
        if (failure === null || details.has(currentCase)) return;
        const location = /^\s+at (\S+)$/.exec(lines[index + 1] ?? '');
        details.set(currentCase, { name: currentCase, message: failure[1] ?? '', location: location?.[1] });
    });
    return details;
};

export const reportOf = (run: FileRun): FileReport => {
    const lines = readFileSync(run.logPath, 'utf8').split('\n');
    const summaryIndex = lines.lastIndexOf(SUMMARY_MARKER);
    const summaryLines = summaryIndex === -1 ? [] : lines.slice(summaryIndex + 1);
    const details = collectFailureDetails(lines);

    const failedCases = summaryLines
        .filter((line) => line.startsWith('FAIL  '))
        .map((line) => line.slice('FAIL  '.length))
        .map((name) => details.get(name) ?? { name, message: '(see the log)', location: undefined });
    const incomplete = summaryIndex === -1;

    return {
        run,
        name: basename(run.file, '.mts'),
        passedCases: summaryLines.filter((line) => line.startsWith('PASS  ')).length,
        failedCases,
        incomplete,
        logTail: lines.filter((line) => line !== '').slice(-LOG_TAIL_LINES),
        ok: run.exitCode === 0 && !run.timedOut && !incomplete && failedCases.length === 0,
    };
};

const seconds = (durationMs: number): string => `${(durationMs / 1000).toFixed(1)}s`;

/** One line per file, printed as soon as the file is done */
export const fileLine = (report: FileReport): string => {
    const duration = seconds(report.run.durationMs);
    if (report.ok) return `PASS  ${report.name}  (${report.passedCases} cases, ${duration})`;
    if (report.run.timedOut) return `FAIL  ${report.name}  (timed out after ${duration})`;
    if (report.incomplete) return `FAIL  ${report.name}  (exit code ${report.run.exitCode ?? 'none'}, no summary, ${duration})`;
    const total = report.passedCases + report.failedCases.length;
    return `FAIL  ${report.name}  (${report.failedCases.length} of ${total} cases failed, ${duration})`;
};

/** What went wrong in one file, for the end of the run */
export const failureLines = (report: FileReport): string[] => {
    const header = `\n── ${report.run.file}  (log: ${report.run.logPath})`;
    if (report.incomplete || report.failedCases.length === 0) {
        return [header, ...report.logTail.map((line) => `    ${line}`)];
    }
    return [
        header,
        ...report.failedCases.flatMap((failedCase) => [
            `  ✗ ${failedCase.name}`,
            `      ${failedCase.message}${failedCase.location === undefined ? '' : `  (${failedCase.location})`}`,
        ]),
    ];
};
