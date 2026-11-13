/** Fixture: passes, and leaves behind what a file may leave when its process ends with it */
import http from 'node:http';
import { expect, reportResults, runCase } from '../../harness.mts';
import { appendToScratch, moduleVisits, noteProcess } from './support.mts';

const results = [
    await runCase('leaves traces behind', () => {
        noteProcess('leaves-traces');
        moduleVisits.push('leaves-traces');
        expect(moduleVisits.length === 1, 'the support module is this file\'s own copy');

        process.env.SHARED_WORKER_FIXTURE_LEFTOVER = 'set by leaves-traces';
        Date.now = () => 0;
        globalThis.fetch = () => Promise.reject(new Error('replaced by leaves-traces'));
        Reflect.set(globalThis, 'sharedWorkerFixtureLeftover', true);
        Object.assign(http, { get: () => 'replaced by leaves-traces' });
        setInterval(() => appendToScratch('ticks', 'x'), 10).unref();
        AbortSignal.timeout(60).addEventListener('abort', () => appendToScratch('aborts', 'x'));
        process.once('exit', (exitCode) => appendToScratch('exit-listener', `leaves-traces:${exitCode}\n`));
        process.on('warning', () => appendToScratch('warning-listener', 'x'));
    }),
];

reportResults(results);
