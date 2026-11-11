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
 *   pnpm test:offline --list             print the files that would run
 *
 * A test is any `scripts/offline/*.mts` file. Helpers live in `support/`; a
 * file that must not run with the suite says `// offline: manual` in its header.
 * Each file runs in its own process with its own scratch database, and its full
 * output (every assertion) goes to a log file named at the end of the run.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killLiveTestProcesses, runFile } from './support/run-file.mts';
import { failureLines, fileLine, reportOf, type FileReport } from './support/run-report.mts';

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
const DURATIONS_PATH = join(RUNNER_DIRECTORY, 'durations.json');
const LOG_DIRECTORY = join(RUNNER_DIRECTORY, `run-${process.pid}`);
const STALE_LOG_AGE_MS = 24 * 60 * 60 * 1000;

interface RunnerOptions {
    nameFilters: string[];
    jobs: number;
    timeoutSeconds: number;
    caseFilter: string | undefined;
    bail: boolean;
    listOnly: boolean;
}

const usage = (): never => {
    console.error('usage: pnpm test:offline [name…] [-j N] [--grep TEXT] [--bail] [--timeout SECONDS] [--list]');
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
        listOnly: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index] ?? '';
        if (argument === '-j' || argument === '--jobs') options.jobs = positiveInteger(argv[(index += 1)]);
        else if (argument === '--timeout') options.timeoutSeconds = positiveInteger(argv[(index += 1)]);
        else if (argument === '--grep') options.caseFilter = argv[(index += 1)] ?? usage();
        else if (argument === '--bail') options.bail = true;
        else if (argument === '--list') options.listOnly = true;
        else if (argument.startsWith('-')) usage();
        else options.nameFilters.push(argument);
    }
    return options;
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

/** Test files as paths relative to the repository root */
const discoverTestFiles = (nameFilters: string[]): string[] => {
    const entries = readdirSync(TEST_DIRECTORY).filter((entry) => entry.endsWith('.mts') && !NOT_TESTS.has(entry));
    return entries
        .filter(
            (entry) => nameFilters.length === 0 || nameFilters.some((filter) => matchesFilter(entry, filter, entries))
        )
        .map((entry) => join(TEST_DIRECTORY, entry))
        .filter((path) => !isManual(path))
        .map((path) => relative(REPOSITORY_ROOT, path));
};

type Durations = Record<string, number>;

const isDurations = (value: unknown): value is Durations =>
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((duration) => typeof duration === 'number');

const readDurations = (): Durations => {
    try {
        const parsed: unknown = JSON.parse(readFileSync(DURATIONS_PATH, 'utf8'));
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

const runAll = async (files: string[], options: RunnerOptions): Promise<FileReport[]> => {
    const queue = [...files];
    const reports: FileReport[] = [];
    let stopped = false;

    const worker = async (): Promise<void> => {
        for (let file = queue.shift(); file !== undefined && !stopped; file = queue.shift()) {
            const run = await runFile(file, {
                repositoryRoot: REPOSITORY_ROOT,
                logPath: join(LOG_DIRECTORY, `${basename(file, '.mts')}.log`),
                timeoutMs: options.timeoutSeconds * 1000,
                caseFilter: options.caseFilter,
            });
            const report = reportOf(run);
            reports.push(report);
            console.log(fileLine(report));
            if (!report.ok && options.bail) stopped = true;
        }
    };
    await Promise.all(Array.from({ length: Math.min(options.jobs, files.length) }, worker));
    return reports;
};

const printSummary = (reports: FileReport[], skippedFiles: number, wallMs: number): void => {
    const failed = reports.filter((report) => !report.ok);
    for (const report of failed) console.log(failureLines(report).join('\n'));

    const passedCases = reports.reduce((total, report) => total + report.passedCases, 0);
    const failedCases = reports.reduce((total, report) => total + report.failedCases.length, 0);
    console.log(
        `\n${failed.length === 0 ? 'OK' : 'FAILED'}: ${reports.length - failed.length} of ${reports.length} files passed, ` +
            `${passedCases} cases passed, ${failedCases} failed, ${(wallMs / 1000).toFixed(0)}s`
    );
    if (skippedFiles > 0) console.log(`${skippedFiles} files were not started (--bail)`);
    if (failed.length > 0) {
        console.log(`rerun: pnpm test:offline ${failed.map((report) => report.name).join(' ')}`);
    }
    console.log(`logs: ${LOG_DIRECTORY}`);
};

const main = async (): Promise<void> => {
    const options = parseArguments(process.argv.slice(2));
    const durations = readDurations();
    const files = longestFirst(discoverTestFiles(options.nameFilters), durations);
    if (files.length === 0) {
        console.error('no test file matches');
        process.exit(2);
    }
    if (options.listOnly) {
        console.log(files.join('\n'));
        return;
    }

    mkdirSync(LOG_DIRECTORY, { recursive: true });
    removeStaleLogs();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => {
            killLiveTestProcesses();
            process.exit(130);
        });
    }

    const startedAt = performance.now();
    const reports = await runAll(files, options);
    printSummary(reports, files.length - reports.length, performance.now() - startedAt);

    // A filtered run times only part of each file, so it must not update the estimates
    if (options.caseFilter === undefined) {
        const measured = Object.fromEntries(
            reports.filter((report) => report.ok).map((report) => [basename(report.run.file), report.run.durationMs])
        );
        writeFileSync(DURATIONS_PATH, JSON.stringify({ ...durations, ...measured }));
    }
    process.exitCode = reports.every((report) => report.ok) && reports.length === files.length ? 0 : 1;
};

await main();
