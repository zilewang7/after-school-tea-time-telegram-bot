/**
 * Offline cases for the time scale of the Telegram call pacing.
 *
 * The harness runs the pacing a hundred times faster so the suite does not wait
 * out real 500ms gaps. These cases pin the two things that makes safe: a scale
 * really shortens the gap, and a broken value (empty, not a number, zero) falls
 * back to production pacing instead of switching it off.
 *
 * Run: pnpm test:offline edit-coordinator
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';

const { parseTimeScale, runApiCall } = await import('../../src/telegram/edit-coordinator.js');

/** Production gap between two calls in the same chat */
const BURST_INTERVAL_MS = 500;

/** Wall time of two back-to-back calls in a chat nothing else has used */
const timeTwoCalls = async (chatId: number): Promise<number> => {
    const startedAt = performance.now();
    await runApiCall(chatId, async () => undefined);
    await runApiCall(chatId, async () => undefined);
    return performance.now() - startedAt;
};

const withTimeScale = async <T,>(value: string | undefined, body: () => Promise<T>): Promise<T> => {
    const previous = process.env.EDIT_COORDINATOR_TIME_SCALE;
    if (value === undefined) delete process.env.EDIT_COORDINATOR_TIME_SCALE;
    else process.env.EDIT_COORDINATOR_TIME_SCALE = value;
    try {
        return await body();
    } finally {
        if (previous === undefined) delete process.env.EDIT_COORDINATOR_TIME_SCALE;
        else process.env.EDIT_COORDINATOR_TIME_SCALE = previous;
    }
};

const results: CaseResult[] = [];

results.push(
    await runCase('a finite positive scale is used as given', () => {
        expect(parseTimeScale('0.01') === 0.01, 'a fraction');
        expect(parseTimeScale('2') === 2, 'a value above one');
    })
);

results.push(
    await runCase('any other value keeps production pacing', () => {
        for (const raw of [undefined, '', '   ', 'abc', '0', '-1', 'Infinity', 'NaN']) {
            expect(parseTimeScale(raw) === 1, `${JSON.stringify(raw)} means 1`);
        }
    })
);

results.push(
    await runCase('the harness scale shortens the gap between two calls', async () => {
        expect(process.env.EDIT_COORDINATOR_TIME_SCALE === '0.01', 'the harness set the scale on import');
        const elapsedMs = await timeTwoCalls(880001);
        expect(elapsedMs < BURST_INTERVAL_MS / 2, `two calls took ${elapsedMs.toFixed(0)}ms`);
    })
);

results.push(
    await runCase('the scale is read on every call, not once at import', async () => {
        const elapsedMs = await withTimeScale('0.2', () => timeTwoCalls(880002));
        expect(elapsedMs >= 90, `a fifth of the production gap was waited out (${elapsedMs.toFixed(0)}ms)`);
        expect(elapsedMs < BURST_INTERVAL_MS, `and not the whole gap (${elapsedMs.toFixed(0)}ms)`);
    })
);

results.push(
    await runCase('an empty scale leaves the production gap in place', async () => {
        const elapsedMs = await withTimeScale('', () => timeTwoCalls(880003));
        // A few ms of slack: timers may fire slightly early
        expect(elapsedMs >= BURST_INTERVAL_MS - 20, `the full gap was waited out (${elapsedMs.toFixed(0)}ms)`);
    })
);

reportResults(results);
