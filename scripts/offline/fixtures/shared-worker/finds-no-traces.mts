/** Fixture: runs after leaves-traces.mts in the same worker and must find none of its traces */
import { existsSync, readFileSync } from 'node:fs';
import http, { get } from 'node:http';
import { join, resolve } from 'node:path';
import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect, reportResults, runCase } from '../../harness.mts';
import { scratchDirectoryOf } from '../../support/scratch-directory.mts';
import { moduleVisits, noteProcess, scratchPath, scratchSizeOf } from './support.mts';

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
/** After the moment the earlier file's leftovers were due */
const MARGIN_MS = 400;

const results = [
    await runCase('finds none of the values an earlier file left', () => {
        noteProcess('finds-no-traces');
        expect(moduleVisits.length === 0, 'the support module is a fresh copy');
        expect(process.env.SHARED_WORKER_FIXTURE_LEFTOVER === undefined, 'the env value is gone');
        expect(Date.now() > 0, 'Date.now is the real one');
        expect(fetch.name === 'fetch', 'fetch is the real one');
        expect(!('sharedWorkerFixtureLeftover' in globalThis), 'the added global is gone');
        expect(http.get.name === 'get', `http.get is the real one (${http.get.name})`);
        expect(get === http.get, 'and so is the one imported by name');
        expect(clearTimeout.name === 'clearTimeout' && clearInterval.name === 'clearInterval', 'timers can be cleared again');
        expect(Error.stackTraceLimit > 0, `errors have a stack again (${Error.stackTraceLimit} frames)`);
        expect(new Error('made here').stack?.includes('finds-no-traces.mts'), 'in the usual format');
        expect(`${process.umask()}` === readFileSync(scratchPath('mask'), 'utf8'), 'the file mode mask is what the earlier file started with');
        expect(!process.argv.includes('--left-by-leaves-traces'), 'the argument the earlier file added is gone');
        expect(process.argv[1] === fileURLToPath(import.meta.url), `the command line names this file (${process.argv[1]})`);
        expect(process.cwd() === REPOSITORY_ROOT, `the working directory is the repository (${process.cwd()})`);
    }),
    await runCase("finds what the earlier file's exit listeners did, once, and nothing after", async () => {
        expect(
            readFileSync(scratchPath('exit-listener'), 'utf8') === 'leaves-traces:0\n',
            'its exit listener ran once, with its exit code'
        );
        expect(readFileSync(scratchPath('exit-listener-kept'), 'utf8') === 'x', 'so did the one it had not registered with `once`');
        expect(
            !existsSync(join(scratchDirectoryOf(process.pid), 'left-by-leaves-traces')),
            'what that listener wrote into the scratch directory is gone'
        );
        expect(process.env.SHARED_WORKER_FIXTURE_SET_LATE === undefined, 'what it set later on did not reach this file');
        process.emitWarning('emitted by finds-no-traces');
        await nextTurn();
        await nextTurn();
        expect(scratchSizeOf('warning-listener') === 0, 'the warning listener of the earlier file is gone');
    }),
    await runCase('none of the work an earlier file left goes on', async () => {
        // Compared with what is there now: on a machine that is busy enough, any of it may have got
        // to write while the earlier file was still ending
        const written = (): string => ['ticks', 'aborts', 'child', 'late-child'].map((note) => `${note}: ${scratchSizeOf(note)}`).join(', ');
        const atStart = written();
        const due = Number(readFileSync(scratchPath('leftovers-due'), 'utf8'));
        await sleep(Math.max(0, due - (performance.timeOrigin + performance.now())) + MARGIN_MS);
        expect(
            written() === atStart,
            `its interval, its AbortSignal.timeout and the child processes it left running wrote nothing more (${atStart} → ${written()})`
        );
    }),
];

reportResults(results);
