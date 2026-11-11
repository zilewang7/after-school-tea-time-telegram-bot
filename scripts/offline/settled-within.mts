/**
 * settledWithin bounds the steps of the shutdown: a step that hangs must not
 * use up the time the steps after it need.
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import { settledWithin } from '../../src/shared/settled-within.js';

const results: CaseResult[] = [];

results.push(
    await runCase('work that settles in time is waited for', async () => {
        let done = false;
        const work = new Promise<void>((resolve) => {
            setTimeout(() => {
                done = true;
                resolve();
            }, 20);
        });
        expect((await settledWithin(work, 2000)) === true, 'reported as settled');
        expect(done, 'and it really finished first');
    })
);

results.push(
    await runCase('a rejection ends the wait and is not thrown', async () => {
        const settled = await settledWithin(Promise.reject(new Error('the proxy is gone')), 2000);
        expect(settled === true, 'a failed step is over too');
    })
);

results.push(
    await runCase('work that hangs is given up at the limit', async () => {
        const startedAt = performance.now();
        const settled = await settledWithin(new Promise<void>(() => undefined), 50);
        const waitedMs = performance.now() - startedAt;
        expect(settled === false, 'reported as not settled');
        expect(waitedMs >= 45 && waitedMs < 1500, `after about the limit (${Math.round(waitedMs)}ms)`);
    })
);

reportResults(results);
