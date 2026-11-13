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
    /**
     * Set when shared workers were asked for and one could not be started: the
     * number of files that had been given to a worker by then. Every file
     * started after that ran in a process of its own.
     */
    sharedUnavailableAfter: number | undefined;
}

export interface RunnerChoice {
    /** `--isolated` */
    isolated: boolean;
    jobs: number;
    fileCount: number;
    /** The runner's own: OFFLINE_DEBUG_HANDLES is read from it */
    environment: Readonly<Record<string, string | undefined>>;
}

/**
 * Shared workers pay off when there are more files than jobs: up to that many,
 * every file has a process to itself anyway. Tracing handles needs the process
 * from its very start.
 */
export const usesSharedWorkers = (choice: RunnerChoice): boolean =>
    !choice.isolated && choice.environment.OFFLINE_DEBUG_HANDLES !== '1' && choice.fileCount > choice.jobs;

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

/** In the worker first; on its own as well when it did not pass there, and without that worker */
const runInWorker = async (worker: SharedWorker, file: string, options: SuiteOptions): Promise<FileReport> => {
    const ranAfter = [...worker.filesRun];
    const logPath = logPathOf(file, options);
    const run = await worker.run(file, logPath, options.timeoutMs);
    const shared = reportOf(run);
    if (shared.ok) return shared;

    // Whatever made the file fail may still be at work in the worker (a package's
    // timer, a helper process): the run that counts must not meet it
    await worker.stop();
    // Keep the log of the shared run: the run on its own writes the file's log
    const sharedLogPath = logPathOf(file, options, '.shared');
    renameSync(logPath, sharedLogPath);
    const alone = await runAlone(file, options);
    const verdict = run.started ? verdictOf(shared) : 'the process had ended before the file started';
    return { ...alone, sharedFailure: { verdict, logPath: sharedLogPath, ranAfter, durationMs: run.durationMs } };
};

export const runSuite = async (files: readonly string[], options: SuiteOptions): Promise<SuiteResult> => {
    const queue = [...files];
    const reports: FileReport[] = [];
    let stopped = false;
    let sharing = options.shared;
    let sharedUnavailableAfter: number | undefined;
    let givenToWorkers = 0;

    const startWorker = (laneNumber: number): Promise<SharedWorker | undefined> =>
        startSharedWorker({
            repositoryRoot: options.repositoryRoot,
            logPath: join(options.logDirectory, `worker-${laneNumber}.log`),
            environment: testEnvironment(options.caseFilter, options.extraEnvironment),
        });

    const lane = async (laneNumber: number): Promise<void> => {
        let worker: SharedWorker | undefined;
        try {
            for (let file = queue.shift(); file !== undefined && !stopped; file = queue.shift()) {
                if (sharing && worker?.isUsable() !== true) {
                    await worker?.stop();
                    worker = await startWorker(laneNumber);
                    if (worker === undefined) {
                        // Every lane: what stopped this worker stops the others too
                        sharing = false;
                        sharedUnavailableAfter ??= givenToWorkers;
                    }
                }
                if (!sharing && worker !== undefined) {
                    // Another lane found that no worker can be started any more
                    await worker.stop();
                    worker = undefined;
                }
                if (worker !== undefined) givenToWorkers += 1;
                const report = worker === undefined ? await runAlone(file, options) : await runInWorker(worker, file, options);
                // The worker a file did not pass in is stopped by then
                if (report.sharedFailure !== undefined) worker = undefined;
                reports.push(report);
                options.onReport(report);
                if (!report.ok && options.bail) stopped = true;
            }
        } finally {
            // Also when a run throws (the log directory is gone): no worker is left waiting for a file
            await worker?.stop();
        }
    };
    await Promise.all(Array.from({ length: Math.min(options.jobs, files.length) }, (_, index) => lane(index + 1)));
    return { reports, sharedUnavailableAfter };
};
