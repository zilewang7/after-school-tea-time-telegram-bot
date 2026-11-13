/** Fixture: every case passes, then a listener for the end of the process throws */
import { expect, reportResults, runCase } from '../../harness.mts';

const results = [
    await runCase("registers an 'exit' listener that throws", () => {
        process.once('exit', () => {
            throw new Error('thrown by an exit listener');
        });
        expect(true, 'the listener is registered');
    }),
];

reportResults(results);
