/**
 * Fixture: passes. What its 'exit' listener starts never runs in a process of
 * its own; in a worker it throws between this file and the next one.
 */
import { expect, reportResults, runCase } from '../../harness.mts';

const results = [
    await runCase("registers an 'exit' listener that starts more work", () => {
        process.once('exit', () => {
            // A tick and not a timer: it runs before the worker can take the next file
            process.nextTick(() => {
                throw new Error('thrown after the end of the file');
            });
        });
        expect(true, 'the listener is registered');
    }),
];

reportResults(results);
