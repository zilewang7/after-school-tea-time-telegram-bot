/**
 * Fixture: leaves a global that nobody can remove, as fixes-a-global.mts does,
 * but not before waits-for-note-one.mts is running. The test needs that file
 * to be in its worker by the time this file's worker is of no further use.
 */
import { expect, reportResults, runCase } from '../../harness.mts';
import { noteProcess, waitForNote } from './support.mts';

const results = [
    await runCase('defines a global for good, once the other file is running', async () => {
        noteProcess('fixes-a-global-late');
        await waitForNote('pid-waits-for-note-one');
        Object.defineProperty(globalThis, 'sharedWorkerFixtureForGood', { value: true, configurable: false });
        expect('sharedWorkerFixtureForGood' in globalThis, 'the global is there');
    }),
];

reportResults(results);
