/** Fixture: every case passes, then a listener for the end of the process sets the exit code */
import { expect, reportResults, runCase } from '../../harness.mts';

const results = [
    await runCase("registers an 'exit' listener that sets the exit code", () => {
        process.once('exit', () => {
            process.exitCode = 4;
        });
        expect(true, 'the listener is registered');
    }),
];

reportResults(results);
