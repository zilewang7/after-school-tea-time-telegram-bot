/**
 * Fixture: passes, and leaves the process deaf to uncaught errors. Those of
 * the next file in the same worker must still end it and reach its log.
 */
import { expect, reportResults, runCase } from '../../harness.mts';

const results = [
    await runCase('takes over what happens to uncaught errors', () => {
        process.removeAllListeners('uncaughtExceptionMonitor');
        process.setUncaughtExceptionCaptureCallback(() => undefined);
        expect(process.hasUncaughtExceptionCaptureCallback(), 'the callback is set');
    }),
];

reportResults(results);
