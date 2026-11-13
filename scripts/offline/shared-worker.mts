/**
 * Shared workers: support/run-suite.mts runs many test files in one process
 * (support/worker/), and a file must come out of it as it would out of a
 * process of its own.
 *
 * The cases run the small test files in fixtures/shared-worker/ through the
 * real scheduler and real workers, and look at the reports and at what the
 * fixtures wrote into a scratch directory.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import { testEnvironment } from './support/run-file.mts';
import { fileLine, sharedFailureLines, type FileReport } from './support/run-report.mts';
import { runSuite, type SuiteOptions } from './support/run-suite.mts';
import { startSharedWorker } from './support/worker-pool.mts';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE_DIRECTORY = 'scripts/offline/fixtures/shared-worker';
const fixture = (name: string): string => `${FIXTURE_DIRECTORY}/${name}.mts`;

// The fixtures run every case and trace nothing, whatever this run was asked to do
delete process.env.OFFLINE_GREP;
delete process.env.OFFLINE_DEBUG_HANDLES;

const scratch = mkdtempSync(join(tmpdir(), 'k-on-bot-shared-worker-'));
process.once('exit', () => rmSync(scratch, { recursive: true, force: true }));

interface Scenario {
    /** Where the fixtures leave their notes and where the logs go */
    directory: string;
    reports: Map<string, FileReport>;
    sharedUnavailable: boolean;
    /** What a fixture appended to the note of that name; '' when there is none */
    noteOf: (name: string) => string;
}

const readOrEmpty = (path: string): string => {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return '';
    }
};

/** Runs the named fixtures in that order, one at a time, in shared workers unless told otherwise */
const runScenario = async (
    scenarioName: string,
    fixtureNames: readonly string[],
    overrides: Partial<SuiteOptions> = {}
): Promise<Scenario> => {
    const directory = join(scratch, scenarioName);
    mkdirSync(directory);
    const { reports, sharedUnavailable } = await runSuite(fixtureNames.map(fixture), {
        repositoryRoot: REPOSITORY_ROOT,
        logDirectory: directory,
        jobs: 1,
        timeoutMs: 30_000,
        caseFilter: undefined,
        bail: false,
        shared: true,
        onReport: () => undefined,
        ...overrides,
        extraEnvironment: { SHARED_WORKER_FIXTURE_DIRECTORY: directory, ...overrides.extraEnvironment },
    });
    return {
        directory,
        reports: new Map(reports.map((report) => [report.name, report])),
        sharedUnavailable,
        noteOf: (name) => readOrEmpty(join(directory, name)),
    };
};

/** The scenarios do not share anything, so they run side by side: most of their time is waiting */
const [sharing, failures, betweenFiles, timeout, filtered, withoutHook, isolated] = await Promise.all([
    runScenario('sharing', ['leaves-traces', 'finds-no-traces', 'uses-package-timer', 'needs-package-timer']),
    runScenario('failures', [
        'fails-one-case',
        'passes',
        'lingers',
        'passes-again',
        'throws-late',
        'never-settles',
        'changes-http-agent',
        'needs-default-http-agent',
        'listens-for-before-exit',
        'throws-on-exit',
        'sets-exit-code-on-exit',
    ]),
    runScenario('between-files', ['fails-after-its-end', 'passes']),
    runScenario('timeout', ['hangs', 'passes'], { timeoutMs: 1500 }),
    runScenario('filtered', ['two-cases', 'passes'], { caseFilter: 'second' }),
    runScenario('without-hook', ['passes', 'passes-again'], { extraEnvironment: { OFFLINE_WORKER_HOOK: 'off' } }),
    runScenario('isolated', ['passes', 'passes-again'], { shared: false }),
]);

/** What a file that was expected to pass did instead, for the message of the assertion */
const outcomeOf = (report: FileReport | undefined): string => {
    if (report === undefined) return 'it did not run';
    // The scratch directory is gone when this file's log is read: quote the failures here
    const sharedLog = report.sharedFailure === undefined ? '' : readOrEmpty(report.sharedFailure.logPath);
    const failuresInWorker = sharedLog.split('\n').filter((line) => line.includes('✗'));
    const failuresAlone = report.failedCases.map((failedCase) => failedCase.message);
    return [fileLine(report), ...failuresInWorker, ...failuresAlone].map((line) => line.trim()).join(' | ');
};

/** Passed where it first ran: in the worker when the scenario shares, without a second run */
const expectPassedAtOnce = (report: FileReport | undefined, description: string): void => {
    const passed = report !== undefined && report.ok && report.sharedFailure === undefined;
    expect(passed, passed ? description : `${description}: ${outcomeOf(report)}`);
};

/** Failed in the worker and again on its own */
const failedBothWays = (report: FileReport | undefined): report is FileReport =>
    report !== undefined && !report.ok && report.sharedFailure !== undefined;

const lineNumberOf = (path: string, text: string): number =>
    readFileSync(join(REPOSITORY_ROOT, path), 'utf8').split('\n').findIndex((line) => line.includes(text)) + 1;

const results: CaseResult[] = [];

results.push(
    await runCase('two files run in one process, each with its own copy of the modules', () => {
        expectPassedAtOnce(sharing.reports.get('leaves-traces'), 'the first file passes in the worker');
        expectPassedAtOnce(sharing.reports.get('finds-no-traces'), 'the second file finds a fresh copy of the support module');
        const firstProcess = sharing.noteOf('pid-leaves-traces');
        expect(firstProcess !== '' && firstProcess === sharing.noteOf('pid-finds-no-traces'), 'both ran in the same process');
    })
);

results.push(
    await runCase('what a file leaves behind is undone before the next file', () => {
        // The second fixture checks each of these itself; it passed, so they held
        expectPassedAtOnce(sharing.reports.get('finds-no-traces'), 'env value, globals, timers and listeners were gone');
        expect(sharing.noteOf('exit-listener') === 'leaves-traces:0\n', 'the exit listener ran once, not again when the worker ended');
        const workerLog = sharing.noteOf('worker-1.log');
        expect(workerLog.includes('leaves-traces.mts had replaced:'), `the worker's log names the file (${workerLog.trim()})`);
        for (const name of ['Date.now', 'fetch', 'sharedWorkerFixtureLeftover', 'node:http.get']) {
            expect(workerLog.includes(name), `the worker's log names ${name}`);
        }
    })
);

results.push(
    await runCase("a package's timer outlives the file that made the package start it", () => {
        expectPassedAtOnce(sharing.reports.get('uses-package-timer'), 'the file that makes undici start its timer passes');
        // Cleared with the first file's timers, undici's timer would never run again
        expectPassedAtOnce(sharing.reports.get('needs-package-timer'), 'a timeout of undici still fires in the next file');
        expect(
            sharing.noteOf('pid-finds-no-traces') !== '' && !sharing.noteOf('worker-1.log').includes('package-timer'),
            'both ran in the worker of the files before them, which had nothing to put back'
        );
    })
);

results.push(
    await runCase('a failing case fails its file and no other, at the same location as on its own', () => {
        const report = failures.reports.get('fails-one-case');
        expect(failedBothWays(report), 'the file fails in the worker and on its own');
        expect(report?.passedCases === 1 && report.failedCases.length === 1, 'one case passed, one failed');
        const line = lineNumberOf(fixture('fails-one-case'), 'arithmetic is broken');
        const location = `${fixture('fails-one-case')}:${line}`;
        expect(report?.failedCases[0]?.location === location, `the failure is at ${location} (${report?.failedCases[0]?.location})`);
        const sharedLog = readOrEmpty(report?.sharedFailure?.logPath ?? '');
        expect(sharedLog.includes(`at ${location}\n`), 'the log of the worker run gives the same location');
        expect(report?.sharedFailure?.verdict.startsWith('1 of 2 cases failed'), 'the worker run reported the same failure');
        expectPassedAtOnce(failures.reports.get('passes'), 'the next file passes');
    })
);

results.push(
    await runCase('a file that leaves a server open fails, and the next file is not affected', () => {
        const report = failures.reports.get('lingers');
        expect(failedBothWays(report), 'the file fails in the worker and on its own');
        expect(report?.lingered, 'on its own the harness ended it for lingering');
        expect(report?.sharedFailure?.verdict.startsWith('still running long after its summary'), 'the worker run failed for the same reason');
        expectPassedAtOnce(failures.reports.get('passes-again'), 'the next file passes in a new worker');
    })
);

results.push(
    await runCase('an error thrown after the summary fails the file and is in its log', () => {
        const report = failures.reports.get('throws-late');
        expect(failedBothWays(report), 'the file fails in the worker and on its own');
        expect(report?.outsideCases?.startsWith('exit code 1 after a clean summary'), 'on its own it ends with exit code 1');
        expect(report?.sharedFailure?.verdict.startsWith('exit code 1 after a clean summary'), 'so it does in the worker');
        const sharedLog = readOrEmpty(report?.sharedFailure?.logPath ?? '');
        expect(sharedLog.includes('Uncaught error: Error: thrown after the summary'), 'the log of the worker run holds the error');
    })
);

results.push(
    await runCase('a top-level await that cannot settle ends the file as Node would', () => {
        const report = failures.reports.get('never-settles');
        expect(failedBothWays(report), 'the file fails in the worker and on its own');
        expect(report?.incomplete && report.run.exitCode === 13, 'on its own Node ends it with exit code 13');
        expect(report?.sharedFailure?.verdict.startsWith('exit code 13, no summary'), 'the worker reports the same');
    })
);

results.push(
    await runCase('a file that only fails after another file counts as passed, with a note', () => {
        expectPassedAtOnce(failures.reports.get('changes-http-agent'), 'the file that changes the agent passes');
        const report = failures.reports.get('needs-default-http-agent');
        expect(report?.ok, 'the affected file passes on its own, which is what counts');
        const sharedFailure = report?.sharedFailure;
        expect(sharedFailure?.verdict.startsWith('1 of 1 cases failed'), 'it had failed in the worker');
        expect(
            sharedFailure?.ranAfter.map((file) => basename(file)).join() === 'changes-http-agent.mts',
            `the note names the file that ran before it (${sharedFailure?.ranAfter.join()})`
        );
        expect(report !== undefined && fileLine(report).startsWith('PASS  needs-default-http-agent  ('), 'its line says PASS');
        expect(report !== undefined && fileLine(report).includes('in a shared process: 1 of 1 cases failed'), 'and what happened in the worker');
        const note = sharedFailureLines([...failures.reports.values()]).join('\n');
        expect(note.includes('2 files did not pass in a shared process'), 'the end of the run lists it');
        expect(note.includes('ran after: changes-http-agent'), 'with the files before it');
        expect(!note.includes('fails-one-case'), 'a file that fails on its own as well is not in that list');
    })
);

results.push(
    await runCase("a file that listens for 'beforeExit' is handed to a process of its own", () => {
        const report = failures.reports.get('listens-for-before-exit');
        expect(report?.ok, 'the file passes on its own');
        expect(report?.sharedFailure?.verdict.startsWith('exit code 75'), `the worker gave it up (${report?.sharedFailure?.verdict})`);
        const sharedLog = readOrEmpty(report?.sharedFailure?.logPath ?? '');
        expect(sharedLog.includes("this file listens for 'beforeExit'"), 'the log of the worker run says why');
        expect(failures.noteOf('before-exit') === 'x', 'its listener ran once, in the process of its own');
    })
);

results.push(
    await runCase("an 'exit' listener ends the file as it would end its process", () => {
        const throwing = failures.reports.get('throws-on-exit');
        expect(failedBothWays(throwing), 'a listener that throws fails the file in the worker and on its own');
        expect(throwing?.run.exitCode === 1, `on its own the exit code is 1 (${throwing?.run.exitCode})`);
        expect(throwing?.sharedFailure?.verdict.startsWith('exit code 1 after a clean summary'), 'the worker reports the same');
        const sharedLog = readOrEmpty(throwing?.sharedFailure?.logPath ?? '');
        expect(sharedLog.includes('Uncaught error: Error: thrown by an exit listener'), 'the log of the worker run holds the error');

        const setting = failures.reports.get('sets-exit-code-on-exit');
        expect(failedBothWays(setting), 'a listener that sets an exit code fails the file in the worker and on its own');
        expect(setting?.run.exitCode === 4, `on its own the exit code is the listener's (${setting?.run.exitCode})`);
        expect(setting?.sharedFailure?.verdict.startsWith('exit code 4 after a clean summary'), 'the worker reports the same');
    })
);

results.push(
    await runCase('a worker that ends between two files does not fail the file it had not started', () => {
        expectPassedAtOnce(betweenFiles.reports.get('fails-after-its-end'), 'the file whose leftover ends the worker had passed');
        const report = betweenFiles.reports.get('passes');
        expect(report?.ok, 'the next file passes');
        // Whether the runner sees the worker end before or after it hands over the next file is a race
        const verdict = report?.sharedFailure?.verdict;
        expect(
            verdict === undefined || verdict === 'the process had ended before the file started',
            `it ran in a new worker, or on its own with the reason named (${verdict})`
        );
        expect(betweenFiles.noteOf('worker-1.log').includes('thrown after the end of the file'), "the worker's log holds the error");
    })
);

results.push(
    await runCase('a file that never ends is stopped at the time limit, in the worker and on its own', () => {
        const report = timeout.reports.get('hangs');
        expect(failedBothWays(report), 'the file fails in the worker and on its own');
        expect(report?.run.timedOut, 'on its own it timed out');
        expect(report?.sharedFailure?.verdict.startsWith('timed out after'), 'in the worker it timed out');
        expectPassedAtOnce(timeout.reports.get('passes'), 'the next file passes in a new worker');
    })
);

results.push(
    await runCase('the case filter reaches the files of a worker', () => {
        const report = filtered.reports.get('two-cases');
        expectPassedAtOnce(report, 'the file passes');
        expect(report?.passedCases === 1 && report.startedCases === 1, 'only the case that matches ran');
    })
);

results.push(
    await runCase('without the module hook every file gets a process of its own', () => {
        expect(withoutHook.sharedUnavailable, 'the run says shared workers could not be used');
        expectPassedAtOnce(withoutHook.reports.get('passes'), 'the first file passes');
        expectPassedAtOnce(withoutHook.reports.get('passes-again'), 'the second file passes');
        const firstProcess = withoutHook.noteOf('pid-passes');
        expect(firstProcess !== '' && firstProcess !== withoutHook.noteOf('pid-passes-again'), 'they ran in two processes');
    })
);

results.push(
    await runCase('a run that does not share gives every file a process of its own', () => {
        expect(!isolated.sharedUnavailable, 'nothing is reported as unavailable');
        expectPassedAtOnce(isolated.reports.get('passes'), 'the first file passes');
        const firstProcess = isolated.noteOf('pid-passes');
        expect(firstProcess !== '' && firstProcess !== isolated.noteOf('pid-passes-again'), 'they ran in two processes');
    })
);

results.push(
    await runCase('a worker is due for replacement after its share of files', async () => {
        const directory = join(scratch, 'replacement');
        mkdirSync(directory);
        const worker = await startSharedWorker({
            repositoryRoot: REPOSITORY_ROOT,
            logPath: join(directory, 'worker.log'),
            environment: testEnvironment(undefined, { SHARED_WORKER_FIXTURE_DIRECTORY: directory }),
            maxFiles: 2,
        });
        expect(worker !== undefined, 'the worker starts');
        if (worker === undefined) return;
        const first = await worker.run(fixture('passes'), join(directory, 'passes.log'), 30_000);
        expect(first.exitCode === 0 && worker.isUsable(), 'after one file it takes another');
        const second = await worker.run(fixture('passes-again'), join(directory, 'passes-again.log'), 30_000);
        expect(second.exitCode === 0 && !worker.isUsable(), 'after two it is due for replacement');
        expect(worker.filesRun.length === 2, 'it knows the files it ran');
        await worker.stop();
    })
);

reportResults(results);
