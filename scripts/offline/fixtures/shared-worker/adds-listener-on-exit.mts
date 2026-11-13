/** Fixture: passes; its 'exit' listener adds a listener that a process of its own would never call */
import { expect, reportResults, runCase } from '../../harness.mts';

const results = [
    await runCase("adds a 'beforeExit' listener from an 'exit' listener", () => {
        process.once('exit', () => {
            process.on('beforeExit', () => undefined);
        });
        expect(process.listenerCount('exit') > 0, 'the listener is registered');
    }),
];

reportResults(results);
