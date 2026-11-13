/**
 * Fixture: passes in a process of its own, where the work its 'exit' listener
 * starts never runs. In a worker that work runs, and what it does is this
 * file's doing, not the next one's.
 */
import { expect, reportResults, runCase } from '../../harness.mts';

const results = [
    await runCase("registers an 'exit' listener that starts more work", () => {
        process.once('exit', () => {
            process.nextTick(() => {
                throw new Error('thrown after the exit listeners');
            });
        });
        expect(true, 'the listener is registered');
    }),
];

reportResults(results);
