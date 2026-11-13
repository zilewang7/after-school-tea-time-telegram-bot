/** Fixture: passes, and leaves a global that nobody can remove or put back */
import { expect, reportResults, runCase } from '../../harness.mts';
import { noteProcess } from './support.mts';

const results = [
    await runCase('defines a global for good', () => {
        noteProcess('fixes-a-global');
        Object.defineProperty(globalThis, 'sharedWorkerFixtureForGood', { value: true, configurable: false });
        expect('sharedWorkerFixtureForGood' in globalThis, 'the global is there');
    }),
];

reportResults(results);
