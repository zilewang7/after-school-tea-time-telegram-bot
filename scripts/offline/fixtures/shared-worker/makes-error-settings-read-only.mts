/** Fixture: passes, having made read-only the settings of Error that the worker changes for a moment */
import { expect, reportResults, runCase } from '../../harness.mts';

const results = [
    await runCase('makes the stack settings of Error read-only', () => {
        Object.defineProperty(Error, 'stackTraceLimit', { writable: false });
        Object.defineProperty(Error, 'prepareStackTrace', { value: Error.prepareStackTrace, writable: false, configurable: true });
        // The worker notes where a timer like this one was started
        const timer = setTimeout(() => undefined, 60_000).unref();
        expect(!timer.hasRef(), 'a timer was started');
    }),
];

reportResults(results);
