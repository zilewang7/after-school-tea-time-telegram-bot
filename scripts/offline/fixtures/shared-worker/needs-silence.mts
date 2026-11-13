/**
 * Fixture: fails while the timer that uses-package-helper.mts made a package
 * start is running, in whatever process. So it fails in that worker, and passes
 * on its own only once that worker is gone.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, reportResults, runCase } from '../../harness.mts';
import { scratchSizeOf } from './support.mts';

const results = [
    await runCase('nothing writes while this file runs', async () => {
        const before = scratchSizeOf('package-ticks');
        await sleep(300);
        const after = scratchSizeOf('package-ticks');
        expect(after === before, `the note of the package's timer has not grown (${before} → ${after})`);
    }),
];

reportResults(results);
