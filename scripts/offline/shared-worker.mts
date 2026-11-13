/**
 * Shared workers: support/run-suite.mts runs many test files in one process
 * (support/worker/), and a file must come out of it as it would out of a
 * process of its own.
 *
 * The cases run the small test files in fixtures/shared-worker/ through the
 * real scheduler and real workers, and look at the reports and at what the
 * fixtures wrote into a scratch directory.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import { testEnvironment } from './support/run-file.mts';
import { failureLines, fileLine, sharedFailureLines, sharedUnavailableLine, type FileReport } from './support/run-report.mts';
import { runSuite, usesSharedWorkers, type SuiteOptions } from './support/run-suite.mts';
import { isRunning } from './support/scratch-directory.mts';
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
    sharedUnavailableAfter: number | undefined;
    /** What a fixture appended to the note of that name; '' when there is none */
    noteOf: (name: string) => string;
    /** The process ids the fixtures appended to the note of that name */
    processIdsOf: (name: string) => number[];
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
    const noteOf = (name: string): string => readOrEmpty(join(directory, name));
    const { reports, sharedUnavailableAfter } = await runSuite(fixtureNames.map(fixture), {
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
        sharedUnavailableAfter,
        noteOf,
        processIdsOf: (name) => noteOf(name).split('\n').filter((line) => line !== '').map(Number),
    };
};

const becomesTrue = async (condition: () => boolean, withinMs: number): Promise<boolean> => {
    const deadline = performance.now() + withinMs;
    while (!condition()) {
        if (performance.now() > deadline) return false;
        await sleep(50);
    }
    return true;
};

/**
 * Ends the process that ran `fixtureName` in the scenario of that name, from
 * inside the runner's report of a file. The runner goes on to the next file
 * without a turn of the event loop in between, the only place where it could
 * learn of the worker's end. So it hands that file to a worker that is gone.
 */
const endWorkerBehindTheRunner = (scenarioName: string, fixtureName: string): void => {
    const processId = Number(readOrEmpty(join(scratch, scenarioName, `pid-${fixtureName}`)));
    process.kill(processId, 'SIGKILL');
};

interface OrphanedWorker {
    /** The file ran in a worker of the runner that was then killed */
    started: boolean;
    /** The worker and the child process of its file ended without the runner */
    gone: boolean;
}

/** Starts a runner of its own (fixtures/shared-worker/suite-process.mts), kills it in the middle of a file and watches the worker */
const orphanWorker = async (): Promise<OrphanedWorker> => {
    const directory = join(scratch, 'orphaned');
    mkdirSync(directory);
    const processIdIn = (note: string): number => Number(readOrEmpty(join(directory, note)));
    const runner = spawn(
        process.execPath,
        ['--import', 'tsx', fixture('suite-process'), directory, fixture('hangs'), fixture('passes')],
        { cwd: REPOSITORY_ROOT, stdio: 'ignore' }
    );
    // The second of the two notes the file writes
    const started = await becomesTrue(() => readOrEmpty(join(directory, 'pid-child-of-hangs')).endsWith('\n'), 30_000);
    runner.kill('SIGKILL');
    if (!started) return { started, gone: false };
    const leftBehind = [processIdIn('pid-hangs'), processIdIn('pid-child-of-hangs')];
    const gone = await becomesTrue(() => !leftBehind.some(isRunning), 10_000);
    if (!gone) {
        // Not left to run on when the test fails
        for (const processId of leftBehind) if (isRunning(processId)) process.kill(processId, 'SIGKILL');
    }
    return { started, gone };
};

interface WorkerLimits {
    /** A worker allowed two files: whether it would take another after the first, and after the second */
    usableAfterOneFile: boolean;
    usableAfterTwoFiles: boolean;
    filesRun: number;
    /** A worker allowed one megabyte: before its first file, and after */
    usableBeforeGrowing: boolean;
    usableAfterGrowing: boolean;
    exitCodes: (number | null | undefined)[];
}

/** Drives two workers by hand, each with a limit that the real suite's workers reach only after many files */
const reachWorkerLimits = async (): Promise<WorkerLimits> => {
    const directory = join(scratch, 'limits');
    mkdirSync(directory);
    const options = {
        repositoryRoot: REPOSITORY_ROOT,
        environment: testEnvironment(undefined, { SHARED_WORKER_FIXTURE_DIRECTORY: directory }),
    };
    const [counted, small] = await Promise.all([
        startSharedWorker({ ...options, logPath: join(directory, 'worker.log'), maxFiles: 2 }),
        startSharedWorker({ ...options, logPath: join(directory, 'small-worker.log'), maxResidentMegabytes: 1 }),
    ]);
    try {
        const first = await counted?.run(fixture('passes'), join(directory, 'passes.log'), 30_000);
        const usableAfterOneFile = counted?.isUsable() === true;
        const second = await counted?.run(fixture('passes-again'), join(directory, 'passes-again.log'), 30_000);
        const usableAfterTwoFiles = counted?.isUsable() === true;
        const usableBeforeGrowing = small?.isUsable() === true;
        const only = await small?.run(fixture('passes'), join(directory, 'passes-small.log'), 30_000);
        return {
            usableAfterOneFile,
            usableAfterTwoFiles,
            filesRun: counted?.filesRun.length ?? 0,
            usableBeforeGrowing,
            usableAfterGrowing: small?.isUsable() === true,
            exitCodes: [first?.exitCode, second?.exitCode, only?.exitCode],
        };
    } finally {
        await Promise.all([counted?.stop(), small?.stop()]);
    }
};

interface Listing {
    /** The files the real runner would run, in its order */
    names: string[];
    /** What it says about how it would run them */
    plan: string;
}

/** Asks the real runner what it would do for these arguments: nothing is started */
const listedBy = async (
    runnerArguments: readonly string[],
    environment: NodeJS.ProcessEnv = process.env
): Promise<Listing> => {
    const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', 'scripts/offline/runner.mts', '--list', ...runnerArguments],
        { cwd: REPOSITORY_ROOT, env: environment }
    );
    return {
        names: stdout.split('\n').filter((line) => line !== '').map((line) => basename(line, '.mts')),
        plan: stderr.trim(),
    };
};

/** In the order the two lanes take them: the first two start together, one in each lane */
const GIVING_UP_FIXTURES = ['fixes-a-global-late', 'waits-for-note-one', 'passes', 'waits-for-note-two', 'passes-again'];

interface SharingGivenUp {
    reports: Map<string, FileReport>;
    sharedUnavailableAfter: number | undefined;
    /** The process that ran the fixture of that name; 0 when it left no note */
    processIdOf: (fixtureName: string) => number;
    /** Whether the second lane's worker was still running when the file that lane ran next had ended */
    idleWorkerWasLeftRunning: boolean | undefined;
}

/**
 * Two lanes, and from the middle of the run no worker can be started. The
 * first lane finds out: its worker is not reusable after its first file. The
 * second lane has a working worker then, and a file still to run. Three of the
 * files wait for a note, which makes the order certain: each ends only when
 * the other lane is where the case needs it.
 */
const giveUpSharingMidRun = async (): Promise<SharingGivenUp> => {
    const directory = join(scratch, 'gives-up-mid-run');
    mkdirSync(directory);
    // Read again for every worker that is started
    const environment: Record<string, string> = { SHARED_WORKER_FIXTURE_DIRECTORY: directory };
    const processIdOf = (fixtureName: string): number => Number(readOrEmpty(join(directory, `pid-${fixtureName}`)));
    let idleWorkerWasLeftRunning: boolean | undefined;
    const { reports, sharedUnavailableAfter } = await runSuite(
        GIVING_UP_FIXTURES.map(fixture),
        {
            repositoryRoot: REPOSITORY_ROOT,
            logDirectory: directory,
            jobs: 2,
            timeoutMs: 30_000,
            caseFilter: undefined,
            bail: false,
            shared: true,
            extraEnvironment: environment,
            onReport: (report) => {
                // This file ended only when the second lane's file was running in its worker. The
                // first lane needs another worker for its next file, and that one will not do.
                if (report.name === 'fixes-a-global-late') environment.OFFLINE_WORKER_HOOK = 'off';
                // That file ran alone, so sharing has been given up: the second lane's file may end.
                // The first lane is kept busy until the second has taken the last file.
                if (report.name === 'passes') writeFileSync(join(directory, 'note-one'), '');
                if (report.name === 'waits-for-note-one') writeFileSync(join(directory, 'note-two'), '');
                if (report.name === 'passes-again') idleWorkerWasLeftRunning = isRunning(processIdOf('waits-for-note-one'));
            },
        }
    );
    return {
        reports: new Map(reports.map((report) => [report.name, report])),
        sharedUnavailableAfter,
        processIdOf,
        idleWorkerWasLeftRunning,
    };
};

/** The scenarios do not share anything, so they run side by side: most of their time is waiting */
const [
    sharing,
    failures,
    lingering,
    endings,
    lateWork,
    forGood,
    unusual,
    packageWork,
    betweenFiles,
    timeout,
    filtered,
    withoutHook,
    isolated,
    orphaned,
    limits,
    givenUp,
    listedInOrder,
    listedTheOtherWay,
    listedFew,
    listedIsolated,
    listedTraced,
] = await Promise.all([
    runScenario('sharing', ['leaves-traces', 'finds-no-traces', 'uses-package-timer', 'needs-package-timer']),
    // A file that fails gets the worker replaced, so the file after one starts in a new worker
    runScenario('failures', ['fails-one-case', 'passes', 'silences-uncaught-errors', 'throws-late']),
    runScenario('lingering', ['lingers', 'passes-again', 'changes-http-agent', 'needs-default-http-agent']),
    runScenario('endings', [
        'never-settles',
        'throws-at-top',
        'throws-an-object',
        'listens-for-before-exit',
        'throws-on-exit',
        'sets-exit-code-on-exit',
    ]),
    runScenario('late-work', ['starts-work-on-exit', 'passes', 'leaves-child-that-throws', 'passes-again']),
    runScenario('for-good', ['fixes-a-global', 'passes', 'enters-a-domain', 'throws-late']),
    // Each of them passes in a process of its own, and nothing it does is in the next one's way
    runScenario('unusual', [
        'leaves-detached-child',
        'makes-error-settings-read-only',
        'sets-exit-code-256',
        'writes-odd-hex',
        'adds-listener-on-exit',
        'replaces-set-immediate',
        'waits-for-a-file',
        'passes',
    ]),
    runScenario('package-work', ['uses-package-helper', 'needs-package-helper', 'needs-silence']),
    runScenario('between-files', ['passes', 'passes-again'], {
        onReport: (report) => {
            if (report.name === 'passes') endWorkerBehindTheRunner('between-files', 'passes');
        },
    }),
    // Also the limit of the files that pass: wide enough for a process of its own on a busy machine
    runScenario('timeout', ['hangs', 'passes'], { timeoutMs: 3000 }),
    runScenario('filtered', ['two-cases', 'passes'], { caseFilter: 'second' }),
    runScenario('without-hook', ['passes', 'passes-again'], { extraEnvironment: { OFFLINE_WORKER_HOOK: 'off' } }),
    runScenario('isolated', ['passes', 'passes-again'], { shared: false }),
    orphanWorker(),
    reachWorkerLimits(),
    giveUpSharingMidRun(),
    // Two real test files, in both orders: one of the two is not the order the runner would choose
    listedBy(['--in-order', 'shared-worker', 'check-deps']),
    listedBy(['--in-order', 'check-deps', 'shared-worker']),
    // The same two files, in each way that gives every file a process of its own
    listedBy(['shared-worker', 'check-deps']),
    listedBy(['--isolated', '--in-order', 'shared-worker', 'check-deps']),
    listedBy(['--in-order', 'shared-worker', 'check-deps'], { ...process.env, OFFLINE_DEBUG_HANDLES: '1' }),
]);

/** How many workers a scenario started in its one lane */
const workersStartedIn = (scenario: Scenario): number => scenario.noteOf('worker-1.log').split('is ready').length - 1;

/** What a file that was expected to pass did instead, for the message of the assertion */
const outcomeOf = (report: FileReport | undefined): string => {
    if (report === undefined) return 'it did not run';
    // The scratch directory is gone when this file's log is read: quote the failures here
    const sharedLog = report.sharedFailure === undefined ? '' : readOrEmpty(report.sharedFailure.logPath);
    const failuresInWorker = sharedLog.split('\n').filter((line) => line.includes('✗'));
    const failuresAlone = report.failedCases.map((failedCase) => failedCase.message);
    // What the harness and the worker say about a file they had to end
    const notes = [...sharedLog.split('\n'), ...report.logTail].filter((line) => line.startsWith('[offline]'));
    return [fileLine(report), ...failuresInWorker, ...failuresAlone, ...notes].map((line) => line.trim()).join(' | ');
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
        expect(
            sharing.noteOf('finds-no-traces.log').includes('✓ the support module is a fresh copy'),
            'the second file finds a fresh copy of the support module'
        );
        const firstProcess = sharing.noteOf('pid-leaves-traces');
        expect(firstProcess !== '' && firstProcess === sharing.noteOf('pid-finds-no-traces'), 'both ran in the same process');
    })
);

results.push(
    await runCase('what a file leaves behind is undone before the next file', () => {
        // The second fixture checks each of these itself; it passed, so they held
        expectPassedAtOnce(sharing.reports.get('finds-no-traces'), 'values, listeners and leftover work were gone');
        expect(sharing.reports.get('finds-no-traces')?.passedCases === 3, 'all three of its cases ran');
        expect(sharing.noteOf('exit-listener') === 'leaves-traces:0\n', 'the exit listener ran once, not again when the worker ended');
        expect(sharing.noteOf('exit-listener-kept') === 'x', 'nor did the one that was not registered with `once`');
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
        const worker = sharing.noteOf('pid-leaves-traces');
        expect(
            sharing.noteOf('pid-uses-package-timer') === worker && sharing.noteOf('pid-needs-package-timer') === worker,
            'both ran in the worker of the files before them'
        );
        // Loading undici fills a slot on globalThis; a worker that took that for the file's doing would undo it
        expect(!sharing.noteOf('worker-1.log').includes('package-timer'), 'the worker had nothing of theirs to put back');
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
        const printed = report === undefined ? '' : failureLines(report).join('\n');
        expect(printed.includes('in a shared process before that: 1 of 2 cases failed'), 'what is printed about the failure names both runs');
        expectPassedAtOnce(failures.reports.get('passes'), 'the next file passes');
        const ranTheFailure = failures.processIdsOf('pid-fails-one-case');
        expect(ranTheFailure.length === 2, 'the failing file ran in the worker and on its own');
        const [ranTheNext] = failures.processIdsOf('pid-passes');
        expect(ranTheNext !== undefined && !ranTheFailure.includes(ranTheNext), 'the next file got another worker');
    })
);

results.push(
    await runCase('a file that leaves a server open fails, and the next file is not affected', () => {
        const report = lingering.reports.get('lingers');
        expect(failedBothWays(report), 'the file fails in the worker and on its own');
        expect(report?.lingered, 'on its own the harness ended it for lingering');
        expect(report?.sharedFailure?.verdict.startsWith('still running long after its summary'), 'the worker run failed for the same reason');
        expectPassedAtOnce(lingering.reports.get('passes-again'), 'the next file passes in a new worker');
    })
);

results.push(
    await runCase('an error thrown after the summary fails the file and is in its log', () => {
        // In the same worker, right before: it removed the worker's listener for such errors and set a callback that swallows them
        expectPassedAtOnce(failures.reports.get('silences-uncaught-errors'), 'the file that silences uncaught errors passes');
        const report = failures.reports.get('throws-late');
        expect(
            report?.sharedFailure?.ranAfter.map((file) => basename(file, '.mts')).join() === 'passes,silences-uncaught-errors',
            `it ran in that worker (${report?.sharedFailure?.ranAfter.join()})`
        );
        expect(failedBothWays(report), 'the file fails in the worker and on its own');
        expect(report?.outsideCases?.startsWith('exit code 1 after a clean summary'), 'on its own it ends with exit code 1');
        expect(report?.sharedFailure?.verdict.startsWith('exit code 1 after a clean summary'), 'so it does in the worker');
        const sharedLog = readOrEmpty(report?.sharedFailure?.logPath ?? '');
        expect(sharedLog.includes('Uncaught error: Error: thrown after the summary'), 'the log of the worker run holds the error');
    })
);

results.push(
    await runCase('a top-level await that cannot settle ends the file as Node would', () => {
        const report = endings.reports.get('never-settles');
        expect(failedBothWays(report), 'the file fails in the worker and on its own');
        expect(report?.incomplete && report.run.exitCode === 13, 'on its own Node ends it with exit code 13');
        expect(report?.sharedFailure?.verdict.startsWith('exit code 13, no summary'), 'the worker reports the same');
    })
);

results.push(
    await runCase('an error at the top level ends the file at once, whatever it left running', () => {
        const report = endings.reports.get('throws-at-top');
        expect(failedBothWays(report), 'the file fails in the worker and on its own');
        expect(report?.incomplete && report.run.exitCode === 1, 'on its own Node ends it with exit code 1');
        expect(report?.sharedFailure?.verdict.startsWith('exit code 1, no summary'), `the worker reports the same (${report?.sharedFailure?.verdict})`);
        // Left to the server it had opened, it would have run into the time limit of 30 s
        expect((report?.sharedFailure?.durationMs ?? Infinity) < 10_000, 'the worker did not wait for the server it had opened');
        const sharedLog = readOrEmpty(report?.sharedFailure?.logPath ?? '');
        expect(sharedLog.includes('Error: thrown at the top level'), 'the log of the worker run holds the error');

        const thrownObject = endings.reports.get('throws-an-object');
        expect(failedBothWays(thrownObject), 'so does a file that throws something that is no Error');
        const logOfThat = readOrEmpty(thrownObject?.sharedFailure?.logPath ?? '');
        expect(logOfThat.includes("{ code: 42, detail: 'a thrown plain object' }"), 'and the log shows what was thrown');
    })
);

results.push(
    await runCase('a file that only fails after another file counts as passed, with a note', () => {
        expectPassedAtOnce(lingering.reports.get('changes-http-agent'), 'the file that changes the agent passes');
        const report = lingering.reports.get('needs-default-http-agent');
        expect(report?.ok, 'the affected file passes on its own, which is what counts');
        const sharedFailure = report?.sharedFailure;
        expect(sharedFailure?.verdict.startsWith('1 of 1 cases failed'), 'it had failed in the worker');
        expect(
            sharedFailure?.ranAfter.map((file) => basename(file, '.mts')).join() === 'passes-again,changes-http-agent',
            `the note names the files that ran before it in that worker (${sharedFailure?.ranAfter.join()})`
        );
        expect(report !== undefined && fileLine(report).startsWith('PASS  needs-default-http-agent  ('), 'its line says PASS');
        expect(report !== undefined && fileLine(report).includes('in a shared process: 1 of 1 cases failed'), 'and what happened in the worker');
        const reports = [...failures.reports.values(), ...lingering.reports.values(), ...endings.reports.values()];
        const note = sharedFailureLines(reports).join('\n');
        expect(note.includes('2 files did not pass in a shared process'), 'the end of the run lists it');
        expect(note.includes('ran after: passes-again, changes-http-agent'), 'with the files before it');
        expect(
            note.includes('pnpm test:offline --in-order passes-again changes-http-agent needs-default-http-agent'),
            'and the command that runs them in one process again'
        );
        expect(!note.includes('fails-one-case'), 'a file that fails on its own as well is not in that list');
        expect(
            sharedFailureLines(reports, 'some "case"').join('\n').includes('--in-order --grep "some \\"case\\"" passes-again'),
            'a run that was limited to some cases gets a command with the same limit'
        );
    })
);

results.push(
    await runCase("a file that listens for 'beforeExit' is handed to a process of its own", () => {
        const report = endings.reports.get('listens-for-before-exit');
        expect(report?.ok, 'the file passes on its own');
        expect(report?.sharedFailure?.verdict.startsWith('exit code 75'), `the worker gave it up (${report?.sharedFailure?.verdict})`);
        const sharedLog = readOrEmpty(report?.sharedFailure?.logPath ?? '');
        expect(sharedLog.includes("this file listens for 'beforeExit'"), 'the log of the worker run says why');
        expect(endings.noteOf('before-exit') === 'x', 'its listener ran once, in the process of its own');
    })
);

results.push(
    await runCase("an 'exit' listener ends the file as it would end its process", () => {
        const throwing = endings.reports.get('throws-on-exit');
        expect(failedBothWays(throwing), 'a listener that throws fails the file in the worker and on its own');
        expect(throwing?.run.exitCode === 1, `on its own the exit code is 1 (${throwing?.run.exitCode})`);
        expect(throwing?.sharedFailure?.verdict.startsWith('exit code 1 after a clean summary'), 'the worker reports the same');
        const sharedLog = readOrEmpty(throwing?.sharedFailure?.logPath ?? '');
        expect(sharedLog.includes('Uncaught error: Error: thrown by an exit listener'), 'the log of the worker run holds the error');

        const setting = endings.reports.get('sets-exit-code-on-exit');
        expect(failedBothWays(setting), 'a listener that sets an exit code fails the file in the worker and on its own');
        expect(setting?.run.exitCode === 4, `on its own the exit code is the listener's (${setting?.run.exitCode})`);
        expect(setting?.sharedFailure?.verdict.startsWith('exit code 4 after a clean summary'), 'the worker reports the same');
    })
);

results.push(
    await runCase("work an 'exit' listener starts is its own file's, not the next one's", () => {
        const report = lateWork.reports.get('starts-work-on-exit');
        // A process of its own is gone before that work runs
        expect(report?.ok, 'the file passes on its own');
        const verdict = report?.sharedFailure?.verdict;
        expect(verdict?.startsWith('exit code 1 after a clean summary'), `in the worker the error ended that file (${verdict})`);
        const sharedLog = readOrEmpty(report?.sharedFailure?.logPath ?? '');
        expect(sharedLog.includes('Uncaught error: Error: thrown after the exit listeners'), 'and is in the log of that run');
        expectPassedAtOnce(lateWork.reports.get('passes'), 'the next file passes');
    })
);

results.push(
    await runCase('a child process a file leaves running is ended with the file, and its end is that file\'s', () => {
        const report = lateWork.reports.get('leaves-child-that-throws');
        expect(report?.ok, 'the file passes on its own, where its process is gone before the child is');
        const verdict = report?.sharedFailure?.verdict;
        // Not waited for, the end of the child would have thrown in the middle of the next file
        expect(verdict?.startsWith('exit code 1 after a clean summary'), `in the worker what the end of the child set off ended that file (${verdict})`);
        const sharedLog = readOrEmpty(report?.sharedFailure?.logPath ?? '');
        expect(sharedLog.includes('Uncaught error: Error: thrown when the child process ended'), 'and is in the log of that run');
        expectPassedAtOnce(lateWork.reports.get('passes-again'), 'the next file passes');
    })
);

results.push(
    await runCase('what a package started for itself is left alone, and so is a detached child process', async () => {
        expectPassedAtOnce(packageWork.reports.get('uses-package-helper'), 'the file that makes a package start a helper process passes');
        // Ended with the first file's own children, the helper would be missing here
        expectPassedAtOnce(packageWork.reports.get('needs-package-helper'), 'the helper process still runs during the next file');
        const worker = packageWork.noteOf('pid-uses-package-helper');
        expect(worker !== '' && worker === packageWork.noteOf('pid-needs-package-helper'), 'which ran in the same worker');
        const [helper] = packageWork.processIdsOf('pid-package-helper');
        expect(helper !== undefined && !isRunning(helper), 'the helper process ended with the worker');

        expectPassedAtOnce(unusual.reports.get('leaves-detached-child'), 'the file that leaves a detached child process passes');
        const wrote = await becomesTrue(() => unusual.noteOf('detached-child') !== '', 10_000);
        expect(wrote, 'that child process got to do its work, as it does after a process of its own');
    })
);

results.push(
    await runCase('the run on its own does not meet the worker the file failed in', () => {
        const report = packageWork.reports.get('needs-silence');
        const verdict = report?.sharedFailure?.verdict;
        expect(verdict?.startsWith('1 of 1 cases failed'), `the file fails in the worker, where the timer of a package runs (${verdict})`);
        // That worker still running, its timer would fail the file here as well
        expect(report?.ok, `it passes on its own: ${outcomeOf(report)}`);
    })
);

results.push(
    await runCase('files that pass on their own pass in a worker, whatever they do on the way out', () => {
        const expected: [string, string][] = [
            ['makes-error-settings-read-only', 'a file that makes the stack settings of Error read-only'],
            ['sets-exit-code-256', 'a file whose exit code has only high bits set'],
            ['writes-odd-hex', 'a file that writes an odd number of hex digits'],
            ['adds-listener-on-exit', "a file whose 'exit' listener adds a 'beforeExit' listener"],
            ['replaces-set-immediate', 'a file that leaves a stub in place of setImmediate'],
            // Not lingering: what keeps it running ends on its own. tsx does this to a file it compiles for the first time.
            ['waits-for-a-file', 'a file that waits for a file operation for longer than a file may linger'],
            ['passes', 'the file after all of them'],
        ];
        for (const [name, description] of expected) expectPassedAtOnce(unusual.reports.get(name), `${description} passes`);
        expect(workersStartedIn(unusual) === 1, `all of them ran in one worker (${workersStartedIn(unusual)})`);
    })
);

results.push(
    await runCase('a worker that cannot undo what a file left is not used for the next file', () => {
        expectPassedAtOnce(forGood.reports.get('fixes-a-global'), 'the file that leaves a global nobody can remove passes');
        expectPassedAtOnce(forGood.reports.get('passes'), 'so does the next file');
        const first = forGood.noteOf('pid-fixes-a-global');
        expect(first !== '' && first !== forGood.noteOf('pid-passes'), 'which ran in another worker');
        const workerLog = forGood.noteOf('worker-1.log');
        expect(
            workerLog.includes('left what cannot be undone') && workerLog.includes('sharedWorkerFixtureForGood'),
            `the worker's log names what was left (${workerLog.trim()})`
        );

        // node:domain stays loaded, and the domain a file was left in takes the uncaught errors of every file after it
        expectPassedAtOnce(forGood.reports.get('enters-a-domain'), 'a file that ends inside a domain passes');
        expect(workerLog.includes('process.domain'), "the worker's log names the domain");
        const afterTheDomain = forGood.reports.get('throws-late');
        expect(failedBothWays(afterTheDomain), `an error thrown late by the next file still fails that file: ${outcomeOf(afterTheDomain)}`);
        expect(workersStartedIn(forGood) === 3, `which ran in a third worker (${workersStartedIn(forGood)})`);
    })
);

results.push(
    await runCase('a worker that ends between two files does not fail the file it had not started', () => {
        expectPassedAtOnce(betweenFiles.reports.get('passes'), 'the file before the worker ended had passed');
        const report = betweenFiles.reports.get('passes-again');
        expect(report?.ok, 'the next file passes, in a process of its own');
        const verdict = report?.sharedFailure?.verdict;
        expect(verdict === 'the process had ended before the file started', `the reason is named (${verdict})`);
        const sharedLog = readOrEmpty(report?.sharedFailure?.logPath ?? '');
        expect(sharedLog.includes('the shared process ended before this file started'), 'and is in the log kept of the first attempt');
        expect(betweenFiles.processIdsOf('pid-passes-again').length === 1, 'the file ran once: the worker never got to it');
    })
);

results.push(
    await runCase('a file that never ends is stopped at the time limit, in the worker and on its own', () => {
        const report = timeout.reports.get('hangs');
        expect(failedBothWays(report), 'the file fails in the worker and on its own');
        expect(report?.run.timedOut, 'on its own it timed out');
        expect(report?.sharedFailure?.verdict.startsWith('timed out after'), 'in the worker it timed out');
        expectPassedAtOnce(timeout.reports.get('passes'), 'the next file passes in a new worker');
        const stopped = [...timeout.processIdsOf('pid-hangs'), ...timeout.processIdsOf('pid-child-of-hangs')];
        expect(stopped.length >= 2, `the file and its child process had started (${stopped.join()})`);
        expect(!stopped.some(isRunning), 'the processes that ran it and the child processes it started are gone');
    })
);

results.push(
    await runCase('a worker whose runner is killed ends itself and what its file had started', () => {
        expect(orphaned.started, 'the file ran in a worker of the runner that was killed');
        expect(orphaned.gone, 'the worker and the child process of the file ended on their own');
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
        expect(withoutHook.sharedUnavailableAfter === 0, 'the run says shared workers could not be used, from the first file on');
        const workerLog = withoutHook.noteOf('worker-1.log');
        expect(/process \d+ is not used: its module hook has no effect/.test(workerLog), `the worker's log says why (${workerLog.trim()})`);
        expect(sharedUnavailableLine(0).includes('every file ran in a process of its own'), 'and so does the end of the run');
        expect(sharedUnavailableLine(2).includes('2 files ran in shared processes'), 'which counts the files that workers did run');
        expectPassedAtOnce(withoutHook.reports.get('passes'), 'the first file passes');
        expectPassedAtOnce(withoutHook.reports.get('passes-again'), 'the second file passes');
        const firstProcess = withoutHook.noteOf('pid-passes');
        expect(firstProcess !== '' && firstProcess !== withoutHook.noteOf('pid-passes-again'), 'they ran in two processes');
    })
);

results.push(
    await runCase('when one lane cannot start a worker any more, the other lane stops using its own', () => {
        const names = GIVING_UP_FIXTURES;
        for (const name of names) expectPassedAtOnce(givenUp.reports.get(name), `${name} passes`);
        expect(
            givenUp.sharedUnavailableAfter === 2,
            `the run says that two files had gone to workers by then (${givenUp.sharedUnavailableAfter})`
        );
        const idleWorker = givenUp.processIdOf('waits-for-note-one');
        const fileAfterIt = givenUp.processIdOf('passes-again');
        expect(
            idleWorker !== 0 && fileAfterIt !== 0 && fileAfterIt !== idleWorker,
            'the next file of the lane whose worker still worked ran in a process of its own'
        );
        expect(givenUp.idleWorkerWasLeftRunning === false, 'and that worker had been stopped by then');
        const processes = new Set(names.map(givenUp.processIdOf));
        expect(processes.size === names.length, `every file after that had a process of its own (${[...processes].join()})`);
    })
);

results.push(
    await runCase('a run that does not share gives every file a process of its own', () => {
        expect(isolated.sharedUnavailableAfter === undefined, 'nothing is reported as unavailable');
        expectPassedAtOnce(isolated.reports.get('passes'), 'the first file passes');
        const firstProcess = isolated.noteOf('pid-passes');
        expect(firstProcess !== '' && firstProcess !== isolated.noteOf('pid-passes-again'), 'they ran in two processes');
    })
);

results.push(
    await runCase('a worker is due for replacement after its share of files or of memory', () => {
        expect(limits.exitCodes.join() === '0,0,0', `the files passed (${limits.exitCodes.join()})`);
        expect(limits.usableAfterOneFile, 'a worker allowed two files takes another after the first');
        expect(!limits.usableAfterTwoFiles, 'after two it is due for replacement');
        expect(limits.filesRun === 2, 'it knows the files it ran');
        expect(limits.usableBeforeGrowing, 'a worker with a memory limit takes its first file');
        expect(!limits.usableAfterGrowing, 'having grown past the limit it is due for replacement');
    })
);

results.push(
    await runCase('the runner shares workers when there are more files than jobs', () => {
        const choice = { isolated: false, jobs: 3, fileCount: 4, environment: {} };
        expect(usesSharedWorkers(choice), 'four files, three at a time: shared');
        expect(!usesSharedWorkers({ ...choice, fileCount: 3 }), 'three files have a process each anyway');
        expect(usesSharedWorkers({ ...choice, fileCount: 2, jobs: 1 }), 'two files, one at a time: shared');
        expect(!usesSharedWorkers({ ...choice, isolated: true }), 'not with --isolated');
        expect(!usesSharedWorkers({ ...choice, environment: { OFFLINE_DEBUG_HANDLES: '1' } }), 'not while handles are traced');
    })
);

results.push(
    await runCase('--in-order keeps the files in the order of the names', () => {
        expect(listedInOrder.names.join() === 'shared-worker,check-deps', `one way round (${listedInOrder.names.join()})`);
        expect(listedTheOtherWay.names.join() === 'check-deps,shared-worker', `and the other (${listedTheOtherWay.names.join()})`);
    })
);

results.push(
    // What the runner prints is the constant it hands to runSuite
    await runCase('the runner decides for shared workers, or against, as its arguments say', () => {
        const ofItsOwn = 'each in a process of its own';
        expect(
            listedInOrder.plan.includes('2 files, 1 at a time, in shared processes'),
            `--in-order puts the files into one worker (${listedInOrder.plan})`
        );
        expect(listedFew.plan.includes(`2 files, 2 at a time, ${ofItsOwn}`), `no more files than run at a time (${listedFew.plan})`);
        expect(listedIsolated.plan.includes(`2 files, 1 at a time, ${ofItsOwn}`), `--isolated (${listedIsolated.plan})`);
        expect(listedTraced.plan.includes(`2 files, 1 at a time, ${ofItsOwn}`), `while handles are traced (${listedTraced.plan})`);
    })
);

reportResults(results);
