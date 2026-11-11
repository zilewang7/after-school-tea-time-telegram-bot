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
    /** Cases that started, counted from the log */
    startedCases: number;
    /** The file ended without printing a summary: it crashed or was killed */
    incomplete: boolean;
    /** Why the file failed although no case in its summary did; undefined otherwise */
    outsideCases: string | undefined;
    /** The harness had to end the file: something it started was still running long after the summary */
    lingered: boolean;
    /** The last lines of the log, shown when there is no summary to go by */
    logTail: string[];
    ok: boolean;
}

const SUMMARY_MARKER = '==== offline summary ====';
const LOG_TAIL_LINES = 25;
/** Printed by the harness when it ends a file that would not end on its own */
const LINGER_MARKER = '[offline] still running ';

const CASE_START = '▶ ';

/**
 * The failures the harness printed while the cases ran. A file that runs its
 * cases concurrently can attribute one to the wrong case; the summary below
 * stays the source of truth for which cases failed.
 */
const collectFailureDetails = (lines: string[]): Map<string, FailedCase> => {
    const details = new Map<string, FailedCase>();
    let currentCase = '';
    lines.forEach((line, index) => {
        if (line.startsWith(CASE_START)) {
            currentCase = line.slice(CASE_START.length);
            return;
        }
        const failure = /^\s+✗ (.*)$/.exec(line);
        if (failure === null || details.has(currentCase)) return;
        const location = /^\s+at (\S+)$/.exec(lines[index + 1] ?? '');
        details.set(currentCase, { name: currentCase, message: failure[1] ?? '', location: location?.[1] });
    });
    return details;
};

/**
 * A file can fail with every case in its summary passing: work a case left
 * behind threw after the summary, or a case ran whose result never reached
 * reportResults.
 */
const failureOutsideCases = (
    run: FileRun,
    incomplete: boolean,
    failedCases: number,
    unreportedCases: number
): string | undefined => {
    if (run.timedOut || incomplete || failedCases > 0) return undefined;
    if (unreportedCases !== 0) return `${unreportedCases} cases ran but are not in the summary`;
    if (run.exitCode !== 0) return `exit code ${run.exitCode ?? 'none'} after a clean summary: an error outside the cases`;
    return undefined;
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
    const passedCases = summaryLines.filter((line) => line.startsWith('PASS  ')).length;
    const startedCases = lines.filter((line) => line.startsWith(CASE_START)).length;

    return {
        run,
        name: basename(run.file, '.mts'),
        passedCases,
        failedCases,
        startedCases,
        incomplete,
        outsideCases: failureOutsideCases(run, incomplete, failedCases.length, startedCases - passedCases),
        lingered: lines.some((line) => line.startsWith(LINGER_MARKER)),
        logTail: lines.filter((line) => line !== '').slice(-LOG_TAIL_LINES),
        ok:
            run.exitCode === 0 &&
            !run.timedOut &&
            !incomplete &&
            failedCases.length === 0 &&
            startedCases === passedCases,
    };
};

const seconds = (durationMs: number): string => `${(durationMs / 1000).toFixed(1)}s`;

/** One line per file, printed as soon as the file is done */
export const fileLine = (report: FileReport): string => {
    const duration = seconds(report.run.durationMs);
    if (report.ok) {
        const lingered = report.lingered ? ', had to be ended: something was left running, see the log' : '';
        return `PASS  ${report.name}  (${report.passedCases} cases, ${duration}${lingered})`;
    }
    if (report.run.timedOut) return `FAIL  ${report.name}  (timed out after ${duration})`;
    if (report.incomplete) return `FAIL  ${report.name}  (exit code ${report.run.exitCode ?? 'none'}, no summary, ${duration})`;
    if (report.outsideCases !== undefined) return `FAIL  ${report.name}  (${report.outsideCases}, ${duration})`;
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
