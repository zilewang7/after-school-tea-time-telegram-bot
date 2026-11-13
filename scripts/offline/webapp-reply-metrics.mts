/**
 * Offline cases for the reply detail's 思考 line (thinking-effort design §6):
 * what the chat asked for, what was actually sent, and the resolver's clamping
 * chain, rendered as facts only.
 *
 * Run: npx tsx scripts/offline/webapp-reply-metrics.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import { thinkingEffortTextOf, type ThinkingEffortFields } from '../../webapp/src/format-metrics.ts';

/** The three thinking columns of one reply metric, every other field irrelevant */
const metricOf = (
    requested: string | null,
    sent: string | null,
    fallback: string | null = null
): ThinkingEffortFields => ({
    thinkingEffortRequested: requested,
    thinkingEffortSent: sent,
    thinkingEffortFallback: fallback,
});

const results: CaseResult[] = [];

results.push(
    await runCase('an old row with all three columns null says it was not recorded', () => {
        expect(thinkingEffortTextOf(metricOf(null, null)) === '未记录', 'all null = 未记录');
        expect(!thinkingEffortTextOf(metricOf(null, null)).includes('模型默认'), 'it must not claim the model default');
        expect(!thinkingEffortTextOf(metricOf(null, null)).includes('跟随厂商默认'), 'it must not claim the vendor default');
    })
);

results.push(
    await runCase('a requested level and the same level sent reads as 请求 X / 实际 显式X', () => {
        expect(
            thinkingEffortTextOf(metricOf('high', 'high')) === '请求 高 / 实际 显式高',
            `high/high (${thinkingEffortTextOf(metricOf('high', 'high'))})`
        );
        expect(
            thinkingEffortTextOf(metricOf('xhigh', 'xhigh')) === '请求 极高 / 实际 显式极高',
            'xhigh uses the page label'
        );
        expect(thinkingEffortTextOf(metricOf('medium', 'medium')) === '请求 中 / 实际 显式中', 'medium');
    })
);

results.push(
    await runCase('an explicit request that was never sent says so', () => {
        expect(
            thinkingEffortTextOf(metricOf('high', null)) === '请求 高（未显式发送）',
            `high/null (${thinkingEffortTextOf(metricOf('high', null))})`
        );
        expect(
            thinkingEffortTextOf(metricOf('minimal', null)) === '请求 极低（未显式发送）',
            'an unusual vendor level keeps its label'
        );
    })
);

results.push(
    await runCase('thinking off reads as 关闭思考, whether it was sent or not', () => {
        expect(thinkingEffortTextOf(metricOf('off', 'off')) === '关闭思考', 'off/off is one fact');
        expect(
            thinkingEffortTextOf(metricOf('off', null)) === '关闭思考（未显式发送）',
            'off/null still says nothing explicit went out'
        );
    })
);

results.push(
    await runCase('the resolver chain is shown with an arrow, never ASCII', () => {
        const clamped = thinkingEffortTextOf(metricOf('xhigh', 'high', 'xhigh->high'));
        expect(clamped === '请求 极高 / 实际 显式高，裁剪 xhigh→high', `xhigh clamped (${clamped})`);
        expect(!clamped.includes('->'), 'the ASCII arrow is formatted away');
        const deep = thinkingEffortTextOf(metricOf('max', 'medium', 'max->xhigh->high->medium'));
        expect(deep === '请求 最大 / 实际 显式中，裁剪 max→xhigh→high→medium', `a multi-step chain (${deep})`);
        expect(!deep.includes('->'), 'every arrow is formatted');
    })
);

results.push(
    await runCase('a fallback chain alone never hides the missing request', () => {
        const only = thinkingEffortTextOf(metricOf(null, null, 'xhigh->high'));
        expect(only === '跟随厂商默认，裁剪 xhigh→high', `vendor default plus a chain (${only})`);
    })
);

results.push(
    await runCase('a value the page does not know is shown as it is', () => {
        expect(
            thinkingEffortTextOf(metricOf('turbo', null)) === '请求 turbo（未显式发送）',
            'an unknown requested value stays readable'
        );
        expect(
            thinkingEffortTextOf(metricOf('high', 'turbo')) === '请求 高 / 实际 显式turbo',
            'an unknown sent value stays readable'
        );
    })
);

results.push(
    await runCase('the degenerate columns still read as facts', () => {
        expect(
            thinkingEffortTextOf(metricOf('high', 'off')) === '请求 高 / 关闭思考',
            'a wider request sent as off says both'
        );
        expect(
            thinkingEffortTextOf(metricOf(null, 'high')) === '跟随厂商默认 / 实际 显式高',
            'a sent level without a chat request is still visible'
        );
    })
);

reportResults(results);
