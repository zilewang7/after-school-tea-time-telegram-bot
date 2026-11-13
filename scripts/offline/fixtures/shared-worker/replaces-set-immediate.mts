/** Fixture: passes, and leaves a stub in place of setImmediate */
import { expect, reportResults, runCase } from '../../harness.mts';

const results = [
    await runCase('replaces setImmediate', () => {
        Reflect.set(globalThis, 'setImmediate', () => undefined);
        // Taken off at the end of the file, the harness's listeners would give the
        // event loop the turn that the worker otherwise asks setImmediate for
        for (const signal of ['SIGINT', 'SIGTERM'] as const) process.removeAllListeners(signal);
        expect(setImmediate.name === '', 'the stub is in place');
    }),
];

reportResults(results);
