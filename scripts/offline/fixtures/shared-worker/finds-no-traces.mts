/** Fixture: runs after leaves-traces.mts in the same worker and must find none of its traces */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises';
import { expect, reportResults, runCase } from '../../harness.mts';
import { moduleVisits, noteProcess, scratchPath, scratchSizeOf } from './support.mts';

const results = [
    await runCase('finds nothing an earlier file left', async () => {
        noteProcess('finds-no-traces');
        expect(moduleVisits.length === 0, 'the support module is a fresh copy');
        expect(process.env.SHARED_WORKER_FIXTURE_LEFTOVER === undefined, 'the env value is gone');
        expect(Date.now() > 0, 'Date.now is the real one');
        expect(fetch.name === 'fetch', 'fetch is the real one');
        expect(!('sharedWorkerFixtureLeftover' in globalThis), 'the added global is gone');
        expect(http.get.name === 'get', 'http.get is the real one');

        // Compared with what is there now: on a busy machine either may have fired while the earlier file still ran
        const ticks = scratchSizeOf('ticks');
        const aborts = scratchSizeOf('aborts');
        await sleep(100);
        expect(scratchSizeOf('ticks') === ticks, 'the interval of the earlier file no longer fires');
        expect(scratchSizeOf('aborts') === aborts, 'its AbortSignal.timeout does not fire any more');

        expect(
            readFileSync(scratchPath('exit-listener'), 'utf8') === 'leaves-traces:0\n',
            'the exit listener of the earlier file ran once, with its exit code'
        );
        process.emitWarning('emitted by finds-no-traces');
        await nextTurn();
        await nextTurn();
        expect(scratchSizeOf('warning-listener') === 0, 'the warning listener of the earlier file is gone');
    }),
];

reportResults(results);
