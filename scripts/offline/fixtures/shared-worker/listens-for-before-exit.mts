/** Fixture: passes, and asks to be told when the event loop runs empty */
import { expect, reportResults, runCase } from '../../harness.mts';
import { appendToScratch } from './support.mts';

const results = [
    await runCase("listens for 'beforeExit'", () => {
        process.once('beforeExit', () => appendToScratch('before-exit', 'x'));
        expect(true, 'the listener is registered');
    }),
];

reportResults(results);
