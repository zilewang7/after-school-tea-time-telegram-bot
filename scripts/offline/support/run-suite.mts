/**
 * Runs a list of test files, a few at a time, and reports each as it ends.
 *
 * Two ways to run a file:
 * - in a process of its own (run-file.mts). Always possible, always the
 *   reference: what a file does there is its result.
 * - in a shared worker (worker-pool.mts), which runs many files one after the
 *   other and loads the packages only once. Much cheaper, and it gives the
 *   same result unless an earlier file left something behind. So a file that
 *   does not pass in a worker is run again on its own, and that run counts.
 */
import { renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { runFile, testEnvironment } from './run-file.mts';
import { reportOf, verdictOf, type FileReport } from './run-report.mts';
import { startSharedWorker, type SharedWorker } from './worker-pool.mts';

export interface SuiteOptions {
    repositoryRoot: string;
    logDirectory: string;
    /** How many files run at the same time */
    jobs: number;
    timeoutMs: number;
    caseFilter: string | undefined;
    /** Start no further file after the first failure */
    bail: boolean;
    /** Use shared workers; false runs every file in a process of its own */
    shared: boolean;
    /** Variables every test gets on top of the runner's own environment */
    extraEnvironment?: Readonly<Record<string, string>>;
    /** Called as soon as a file is done */
    onReport: (report: FileReport) => void;
}

export interface SuiteResult {
    reports: FileReport[];
    /** Shared workers were asked for and could not be used: every file ran on its own */
    sharedUnavailable: boolean;
}

const logPathOf = (file: string, options: SuiteOptions, suffix = ''): string =>
    join(options.logDirectory, `${basename(file, '.mts')}${suffix}.log`);

const runAlone = async (file: string, options: SuiteOptions): Promise<FileReport> =>
    reportOf(
        await runFile(file, {
            repositoryRoot: options.repositoryRoot,
            logPath: logPathOf(file, options),
            timeoutMs: options.timeoutMs,
            caseFilter: options.caseFilter,
            extraEnvironment: options.extraEnvironment,
        })
    );

/** In the worker first; on its own as well when it did not pass there */
const runInWorker = async (worker: SharedWorker, file: string, options: SuiteOptions): Promise<FileReport> => {
    const ranAfter = [...worker.filesRun];
    const logPath = logPathOf(file, options);
    const run = await worker.run(file, logPath, options.timeoutMs);
    const shared = reportOf(run);
    if (shared.ok) return shared;

    // Keep the log of the shared run: the run on its own writes the file's log
    const sharedLogPath = logPathOf(file, options, '.shared');
    renameSync(logPath, sharedLogPath);
    const alone = await runAlone(file, options);
    const verdict = run.started ? verdictOf(shared) : 'the process had ended before the file started';
    return { ...alone, sharedFailure: { verdict, logPath: sharedLogPath, ranAfter } };
};

export const runSuite = async (files: readonly string[], options: SuiteOptions): Promise<SuiteResult> => {
    const queue = [...files];
    const reports: FileReport[] = [];
    let stopped = false;
    let sharing = options.shared;
    let sharedUnavailable = false;

    const lane = async (laneNumber: number): Promise<void> => {
        let worker: SharedWorker | undefined;
        for (let file = queue.shift(); file !== undefined && !stopped; file = queue.shift()) {
            if (sharing && worker?.isUsable() !== true) {
                await worker?.stop();
                worker = await startSharedWorker({
                    repositoryRoot: options.repositoryRoot,
                    logPath: join(options.logDirectory, `worker-${laneNumber}.log`),
                    environment: testEnvironment(options.caseFilter, options.extraEnvironment),
                });
                if (worker === undefined) {
                    // Every lane: what stopped this worker stops the others too
                    sharing = false;
                    sharedUnavailable = true;
                }
            }
            const report = worker === undefined || !sharing ? await runAlone(file, options) : await runInWorker(worker, file, options);
            if (report.sharedFailure !== undefined) {
                // Whatever made the file fail there may still be in the worker
                await worker?.stop();
                worker = undefined;
            }
            reports.push(report);
            options.onReport(report);
            if (!report.ok && options.bail) stopped = true;
        }
        await worker?.stop();
    };
    await Promise.all(Array.from({ length: Math.min(options.jobs, files.length) }, (_, index) => lane(index + 1)));
    return { reports, sharedUnavailable };
};
