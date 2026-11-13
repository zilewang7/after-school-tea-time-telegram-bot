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
    /** Cases that started, counted from the lines runCase writes */
    startedCases: number;
    /** The file ended without printing a summary: it crashed or was killed */
    incomplete: boolean;
    /** Why the file failed although no case in its summary did; undefined otherwise */
    outsideCases: string | undefined;
    /** The harness had to end the file, which fails it: something it started was still running long after the summary */
    lingered: boolean;
    /** The last lines of the log, shown when there is no summary to go by */
    logTail: string[];
    ok: boolean;
    /**
     * Set when the file first ran in a shared worker and did not pass there.
     * Everything else in this report is then from the run in a process of its
     * own that followed, which is the one that counts.
     */
    sharedFailure?: SharedFailure;
}

export interface SharedFailure {
    /** What the shared run ended with, in the words of `verdictOf` */
    verdict: string;
    logPath: string;
    /** The files the same worker had run before, in order */
    ranAfter: string[];
    durationMs: number;
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
    unreportedCases: number,
    lingered: boolean
): string | undefined => {
    if (run.timedOut || incomplete || failedCases > 0) return undefined;
    if (unreportedCases > 0) return `${unreportedCases} cases ran but are not in the summary`;
    if (unreportedCases < 0) return `the summary lists ${-unreportedCases} more cases than runCase started`;
    if (lingered) return 'still running long after its summary: something a case started was never ended, see the log';
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
    const lingered = lines.some((line) => line.startsWith(LINGER_MARKER));

    return {
        run,
        name: basename(run.file, '.mts'),
        passedCases,
        failedCases,
        startedCases,
        incomplete,
        outsideCases: failureOutsideCases(run, incomplete, failedCases.length, startedCases - passedCases, lingered),
        lingered,
        logTail: lines.filter((line) => line !== '').slice(-LOG_TAIL_LINES),
        ok:
            run.exitCode === 0 &&
            !run.timedOut &&
            !incomplete &&
            failedCases.length === 0 &&
            startedCases === passedCases &&
            !lingered,
    };
};

const seconds = (durationMs: number): string => `${(durationMs / 1000).toFixed(1)}s`;

/** How one run of a file ended, without the file's name */
export const verdictOf = (report: FileReport): string => {
    const duration = seconds(report.run.durationMs);
    if (report.ok) return `${report.passedCases} cases, ${duration}`;
    if (report.run.timedOut) return `timed out after ${duration}`;
    if (report.incomplete) return `exit code ${report.run.exitCode ?? 'none'}, no summary, ${duration}`;
    if (report.outsideCases !== undefined) return `${report.outsideCases}, ${duration}`;
    const total = report.passedCases + report.failedCases.length;
    return `${report.failedCases.length} of ${total} cases failed, ${duration}`;
};

/** One line per file, printed as soon as the file is done */
export const fileLine = (report: FileReport): string => {
    const verdict = verdictOf(report);
    if (!report.ok) return `FAIL  ${report.name}  (${verdict})`;
    if (report.sharedFailure === undefined) return `PASS  ${report.name}  (${verdict})`;
    return `PASS  ${report.name}  (${verdict} on its own; in a shared process: ${report.sharedFailure.verdict})`;
};

/** What went wrong in one file, for the end of the run */
export const failureLines = (report: FileReport): string[] => {
    const header = [`\n── ${report.run.file}  (log: ${report.run.logPath})`];
    if (report.sharedFailure !== undefined) {
        // What follows is from the run on its own; the first run is not lost
        const { verdict, logPath } = report.sharedFailure;
        header.push(`   in a shared process before that: ${verdict}  (log: ${logPath})`);
    }
    if (report.incomplete || report.failedCases.length === 0) {
        return [...header, ...report.logTail.map((line) => `    ${line}`)];
    }
    return [
        ...header,
        ...report.failedCases.flatMap((failedCase) => [
            `  ✗ ${failedCase.name}`,
            `      ${failedCase.message}${failedCase.location === undefined ? '' : `  (${failedCase.location})`}`,
        ]),
    ];
};

/**
 * The files that did not pass in a shared worker and passed on their own. They
 * count as passed; the note is for whoever looks for what an earlier file left
 * behind.
 */
export const sharedFailureLines = (reports: FileReport[], caseFilter?: string): string[] => {
    const affected = reports.filter((report) => report.ok && report.sharedFailure !== undefined);
    if (affected.length === 0) return [];
    // With the filter of this run: an earlier file left behind what the cases that ran did
    const again = `pnpm test:offline --in-order${caseFilter === undefined ? '' : ` --grep ${JSON.stringify(caseFilter)}`}`;
    return [
        `\n${affected.length === 1 ? '1 file did not pass in a shared process and passed on its own' : `${affected.length} files did not pass in a shared process and passed on their own`} (counted as passed):`,
        ...affected.flatMap((report) => {
            const earlier = report.sharedFailure?.ranAfter.map((file) => basename(file, '.mts')) ?? [];
            return [
                `  ${report.name}: ${report.sharedFailure?.verdict ?? ''}`,
                `      ran after: ${earlier.length === 0 ? '(first file of its process)' : earlier.join(', ')}`,
                `      log of that run: ${report.sharedFailure?.logPath ?? ''}`,
                ...(earlier.length === 0
                    ? []
                    : [`      the same files in one process again: ${again} ${[...earlier, report.name].join(' ')}`]),
            ];
        }),
        '  Either an earlier file of the same process left something behind that the worker does not undo,',
        "  or the file ends differently there (what its 'exit' listeners start gets to run), or it depends on timing.",
    ];
};

/** For the end of a run that asked for shared workers and did not get them, or not to the end */
export const sharedUnavailableLine = (filesGivenToWorkers: number): string => {
    const why = 'the worker-N.log files in the log directory say why';
    if (filesGivenToWorkers === 0) return `shared workers could not be used (${why}): every file ran in a process of its own`;
    const inWorkers = filesGivenToWorkers === 1 ? '1 file' : `${filesGivenToWorkers} files`;
    return `a shared worker could not be started (${why}): ${inWorkers} ran in shared processes, the others in processes of their own`;
};

/** How the files are run, said before the first of them starts */
export const planLine = (fileCount: number, jobs: number, shared: boolean): string => {
    const files = `${fileCount} ${fileCount === 1 ? 'file' : 'files'}`;
    const atATime = Math.min(jobs, fileCount);
    return `${files}, ${atATime} at a time, ${shared ? 'in shared processes' : 'each in a process of its own'}`;
};
