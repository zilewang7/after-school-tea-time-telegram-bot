/**
 * Runs the offline suite: finds the test files, runs a few at a time, and
 * reports every failure instead of stopping at the first one.
 *
 *   pnpm test:offline                    every file
 *   pnpm test:offline run tools          the files run.mts and tools.mts
 *   pnpm test:offline panel share        files whose name contains "panel" or "share"
 *   pnpm test:offline -j 2               two files at a time (default 3)
 *   pnpm test:offline --grep "atlas"     only the cases whose name contains the text
 *   pnpm test:offline --bail             start no further file after the first failure
 *   pnpm test:offline --timeout 300      seconds a single file may take (default 120)
 *   pnpm test:offline --isolated         every file in a process of its own
 *   pnpm test:offline --in-order a b c   one at a time, in the order of the names
 *   pnpm test:offline --list             print the files that would run (and, on stderr, how)
 *
 * A test is any `scripts/offline/*.mts` file. Helpers live in `support/`; a
 * file that must not run with the suite says `// offline: manual` in its header.
 * Each file has its own scratch database and its own copy of the repository's
 * modules, and its full output (every assertion) goes to a log file named at
 * the end of the run.
 *
 * With more files than jobs, the files run in shared worker processes that load
 * the packages once (support/run-suite.mts); a file that does not pass there is
 * run again in a process of its own, and that result counts. A few files, or
 * `--isolated`, or OFFLINE_DEBUG_HANDLES=1: a process per file from the start.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killLiveTestProcesses } from './support/process-groups.mts';
import {
    failureLines,
    fileLine,
    planLine,
    sharedFailureLines,
    sharedUnavailableLine,
    type FileReport,
} from './support/run-report.mts';
import { runSuite, usesSharedWorkers } from './support/run-suite.mts';
import { removeAbandonedScratchDirectories } from './support/scratch-directory.mts';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TEST_DIRECTORY = join(REPOSITORY_ROOT, 'scripts', 'offline');
/** Not tests: the harness, its Telegram double, and this file */
const NOT_TESTS = new Set(['harness.mts', 'fake-telegram.mts', 'runner.mts']);
const MANUAL_MARKER = '// offline: manual';
/** How far into a file the marker is looked for */
const MARKER_SEARCH_LINES = 40;

/** Two cores saturate at about three test processes (measured: 4 is no faster and trips timeouts) */
const DEFAULT_JOBS = 3;
const DEFAULT_TIMEOUT_SECONDS = 120;

const RUNNER_DIRECTORY = join(tmpdir(), 'k-on-bot-offline-runner');
/** A file takes much less time in a shared worker, so each way of running keeps its own estimates */
const durationsPathOf = (shared: boolean): string =>
    join(RUNNER_DIRECTORY, shared ? 'durations-shared.json' : 'durations.json');
const LOG_DIRECTORY = join(RUNNER_DIRECTORY, `run-${process.pid}`);
const STALE_LOG_AGE_MS = 24 * 60 * 60 * 1000;

interface RunnerOptions {
    nameFilters: string[];
    jobs: number;
    timeoutSeconds: number;
    caseFilter: string | undefined;
    bail: boolean;
    isolated: boolean;
    /**
     * Run the files one at a time, in the order of the names given: what a
     * shared worker did when a file failed only after the files before it
     */
    inOrder: boolean;
    listOnly: boolean;
}

const usage = (): never => {
    console.error(
        'usage: pnpm test:offline [name…] [-j N] [--grep TEXT] [--bail] [--timeout SECONDS] [--isolated] [--in-order] [--list]'
    );
    process.exit(2);
};

const positiveInteger = (raw: string | undefined): number => {
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : usage();
};

const parseArguments = (argv: string[]): RunnerOptions => {
    const options: RunnerOptions = {
        nameFilters: [],
        jobs: DEFAULT_JOBS,
        timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
        caseFilter: undefined,
        bail: false,
        isolated: false,
        inOrder: false,
        listOnly: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index] ?? '';
        if (argument === '-j' || argument === '--jobs') options.jobs = positiveInteger(argv[(index += 1)]);
        else if (argument === '--timeout') options.timeoutSeconds = positiveInteger(argv[(index += 1)]);
        else if (argument === '--grep') options.caseFilter = argv[(index += 1)] ?? usage();
        else if (argument === '--bail') options.bail = true;
        else if (argument === '--isolated') options.isolated = true;
        else if (argument === '--in-order') options.inOrder = true;
        else if (argument === '--list') options.listOnly = true;
        else if (argument.startsWith('-')) usage();
        else options.nameFilters.push(argument);
    }
    // One lane: with more, the files of one worker would not be the ones named
    return options.inOrder ? { ...options, jobs: 1 } : options;
};

const isManual = (path: string): boolean =>
    readFileSync(path, 'utf8').split('\n', MARKER_SEARCH_LINES).some((line) => line.trim() === MANUAL_MARKER);

/**
 * A filter that names a test file (`run`, `run.mts`, `scripts/offline/run.mts`)
 * selects that file alone; any other filter selects by substring.
 */
const matchesFilter = (entry: string, filter: string, entries: readonly string[]): boolean => {
    const exactName = `${basename(filter, '.mts')}.mts`;
    return entries.includes(exactName) ? entry === exactName : entry.includes(filter);
};

/** Test files as paths relative to the repository root, in the order of the filters that select them */
const discoverTestFiles = (nameFilters: string[]): string[] => {
    const entries = readdirSync(TEST_DIRECTORY).filter((entry) => entry.endsWith('.mts') && !NOT_TESTS.has(entry));
    // A mistyped name must not turn into a green run of the other names
    const unmatched = nameFilters.filter((filter) => !entries.some((entry) => matchesFilter(entry, filter, entries)));
    if (unmatched.length > 0) {
        console.error(`no test file matches: ${unmatched.join(', ')}`);
        process.exit(2);
    }
    const selected =
        nameFilters.length === 0
            ? entries
            : new Set(nameFilters.flatMap((filter) => entries.filter((entry) => matchesFilter(entry, filter, entries))));
    return [...selected]
        .map((entry) => join(TEST_DIRECTORY, entry))
        .filter((path) => !isManual(path))
        .map((path) => relative(REPOSITORY_ROOT, path));
};

type Durations = Record<string, number>;

const isDurations = (value: unknown): value is Durations =>
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((duration) => typeof duration === 'number');

const readDurations = (path: string): Durations => {
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
        return isDurations(parsed) ? parsed : {};
    } catch {
        return {};
    }
};

/**
 * Longest first, so the slow files do not end up alone at the tail of the run.
 * A file never seen before is ranked by its size.
 */
const longestFirst = (files: string[], durations: Durations): string[] => {
    const estimate = (file: string): number =>
        durations[basename(file)] ?? statSync(join(REPOSITORY_ROOT, file)).size / 10;
    return [...files].sort((left, right) => estimate(right) - estimate(left));
};

const removeStaleLogs = (): void => {
    for (const entry of readdirSync(RUNNER_DIRECTORY)) {
        if (!entry.startsWith('run-')) continue;
        const path = join(RUNNER_DIRECTORY, entry);
        if (Date.now() - statSync(path).mtimeMs > STALE_LOG_AGE_MS) rmSync(path, { recursive: true, force: true });
    }
};

const printSummary = (reports: FileReport[], skippedFiles: number, wallMs: number, caseFilter: string | undefined): void => {
    const failed = reports.filter((report) => !report.ok);
    for (const report of failed) console.log(failureLines(report).join('\n'));

    const passedCases = reports.reduce((total, report) => total + report.passedCases, 0);
    const failedCases = reports.reduce((total, report) => total + report.failedCases.length, 0);
    console.log(
        `\n${failed.length === 0 && passedCases > 0 ? 'OK' : 'FAILED'}: ${reports.length - failed.length} of ${reports.length} files passed, ` +
            `${passedCases} cases passed, ${failedCases} failed, ${(wallMs / 1000).toFixed(0)}s`
    );
    if (skippedFiles > 0) console.log(`${skippedFiles} files were not started (--bail)`);
    if (failed.length > 0) {
        console.log(`rerun: pnpm test:offline ${failed.map((report) => report.name).join(' ')}`);
    }
    for (const line of sharedFailureLines(reports, caseFilter)) console.log(line);
    console.log(`logs: ${LOG_DIRECTORY}`);
};

const main = async (): Promise<void> => {
    const options = parseArguments(process.argv.slice(2));
    const discovered = discoverTestFiles(options.nameFilters);
    if (discovered.length === 0) {
        console.error('no test file matches');
        process.exit(2);
    }
    const shared = usesSharedWorkers({
        isolated: options.isolated,
        jobs: options.jobs,
        fileCount: discovered.length,
        environment: process.env,
    });
    const durationsPath = durationsPathOf(shared);
    const durations = readDurations(durationsPath);
    const files = options.inOrder ? discovered : longestFirst(discovered, durations);
    const plan = planLine(files.length, options.jobs, shared);
    if (options.listOnly) {
        // Not on stdout: that is the names alone, one per line
        console.error(plan);
        console.log(files.join('\n'));
        return;
    }
    console.log(plan);

    mkdirSync(LOG_DIRECTORY, { recursive: true });
    removeStaleLogs();
    removeAbandonedScratchDirectories();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => {
            killLiveTestProcesses();
            process.exit(128 + constants.signals[signal]);
        });
    }

    const startedAt = performance.now();
    const { reports, sharedUnavailableAfter } = await runSuite(files, {
        repositoryRoot: REPOSITORY_ROOT,
        logDirectory: LOG_DIRECTORY,
        jobs: options.jobs,
        timeoutMs: options.timeoutSeconds * 1000,
        caseFilter: options.caseFilter,
        bail: options.bail,
        shared,
        onReport: (report) => console.log(fileLine(report)),
    });
    printSummary(reports, files.length - reports.length, performance.now() - startedAt, options.caseFilter);
    if (sharedUnavailableAfter !== undefined) console.log(sharedUnavailableLine(sharedUnavailableAfter));

    // A filtered run times only part of each file, and a file that needed a
    // second run has no time of its own: neither updates the estimates. Nor
    // does a run that had to fall back to a process per file.
    if (options.caseFilter === undefined && sharedUnavailableAfter === undefined) {
        const measured = Object.fromEntries(
            reports
                .filter((report) => report.ok && report.sharedFailure === undefined)
                .map((report) => [basename(report.run.file), report.run.durationMs])
        );
        writeFileSync(durationsPath, JSON.stringify({ ...durations, ...measured }));
    }
    const passedCases = reports.reduce((total, report) => total + report.passedCases, 0);
    if (passedCases === 0 && reports.every((report) => report.ok)) {
        // Every file "passed" without running anything: the filter is wrong
        console.error(options.caseFilter === undefined ? 'no case ran' : `no case name contains "${options.caseFilter}"`);
        process.exitCode = 1;
        return;
    }
    process.exitCode = reports.every((report) => report.ok) && reports.length === files.length ? 0 : 1;
};

await main();
