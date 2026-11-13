/**
 * Offline cases for the runtime thinking-level resolution (thinking-effort
 * design 2026-1113-1742 §3.2/§3.4): the matrix a chat setting × model produces,
 * the code fallback that keeps an unknown model's request byte-identical, the
 * PlatformConfig fragment and reply_metrics facts the request builder returns,
 * and the continue-time consistency check.
 *
 * Run: pnpm test:offline thinking-effort
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';

type ModelCatalogCapabilities = import('../../src/config/model-capabilities.js').ModelCatalogCapabilities;
type ResumeRequestFacts = import('../../src/reply/resume/reply-checkpoint.js').ResumeRequestFacts;
type ThinkingEffortValue = import('../../src/services/thinking-effort-values.js').ThinkingEffortValue;

const { capabilitySeedOf } = await import('../../src/config/model-capability-seed.js');
const { seedModelCatalogEntries, setModelCatalog } = await import('../../src/config/model-catalog.js');
const { resolveThinkingEffort } = await import('../../src/ai/thinking-effort.js');
const { thinkingRequestOf } = await import('../../src/reply/thinking-request.js');
const {
    thinkingEffortChangeOf,
    thinkingEffortRefusalNoticeOf,
    THINKING_EFFORT_CHANGED_NOTICE,
    THINKING_EFFORT_DATA_CHANGED_NOTICE,
} = await import('../../src/reply/resume/resume-facts.js');

/** The menu rows the catalog starts with, plus the two image/seed-only ids */
setModelCatalog(seedModelCatalogEntries());

const resolvedJson = (model: string, requested: string | null): string => {
    const resolved = resolveThinkingEffort(model, requested);
    return JSON.stringify({
        mode: resolved.mode,
        value: resolved.value,
        clamped: resolved.clamped,
        source: resolved.source,
    });
};

const expectResolution = (
    model: string,
    requested: string | null,
    expected: { mode: string; value: string | null; clamped: boolean; source: string }
): void => {
    const actual = resolvedJson(model, requested);
    const wanted = JSON.stringify(expected);
    expect(actual === wanted, `${model} / ${String(requested)}: ${actual} == ${wanted}`);
};

const requestJson = (model: string, requested: string | null): string => {
    const request = thinkingRequestOf(model, requested);
    return JSON.stringify({ platform: request.platform, facts: request.facts });
};

const results: CaseResult[] = [];
const SOURCES = ['gemini-4-hydrogen', 'gemini-4-argon', 'deepseek-flash', 'mimo-v2.6-flash', 'gpt-6-luna'] as const;

results.push(
    await runCase('the menu models resolve from their data, not from code', async () => {
        for (const model of SOURCES) {
            const resolved = resolveThinkingEffort(model, null);
            expect(resolved.source === 'model-default', `${model}: a menu model has data (got ${resolved.source})`);
            expect(resolved.mode === 'default' && resolved.value === null, `${model}: no setting overrides nothing`);
        }
        for (const model of ['gemini-3.8-flash', 'gemini-nano-banana-2.1']) {
            expect(resolveThinkingEffort(model, null).source !== 'code', `${model}: the seed counts as data`);
        }
        // The relay-only image id has no reasoning section at all: nothing to resolve
        expect(
            resolveThinkingEffort('gpt-image-2.5-dev', 'high').source === 'code',
            'a model without a reasoning section falls back to code'
        );
    })
);

results.push(
    await runCase('the matrix: default setting, graded value, clamp and toggle', async () => {
        // A model with a full ladder keeps a supported value as-is
        expectResolution('gemini-4-hydrogen', null, { mode: 'default', value: null, clamped: false, source: 'model-default' });
        expectResolution('gemini-4-hydrogen', 'low', { mode: 'explicit', value: 'low', clamped: false, source: 'chat' });
        expectResolution('gemini-4-hydrogen', 'xhigh', { mode: 'explicit', value: 'xhigh', clamped: false, source: 'chat' });
        expectResolution('gpt-6-luna', 'none', { mode: 'explicit', value: 'none', clamped: false, source: 'chat' });
        expectResolution('gpt-6-luna', 'medium', { mode: 'explicit', value: 'medium', clamped: false, source: 'chat' });
        // A value above the model's ceiling clamps down to its top level
        expectResolution('gemini-4-argon', 'xhigh', { mode: 'explicit', value: 'high', clamped: true, source: 'chat' });
        expectResolution('gemini-4-hydrogen', 'max', { mode: 'explicit', value: 'xhigh', clamped: true, source: 'chat' });
        // A value below the model's floor clamps up to its lowest level
        expectResolution('gemini-4-hydrogen', 'minimal', { mode: 'explicit', value: 'low', clamped: true, source: 'chat' });
        expectResolution('gemini-4-argon', 'none', { mode: 'explicit', value: 'low', clamped: true, source: 'chat' });
        // A gap in the ladder clamps to the highest supported level below it
        expectResolution('deepseek-flash', 'medium', { mode: 'explicit', value: 'low', clamped: true, source: 'chat' });
        expectResolution('deepseek-flash', 'max', { mode: 'explicit', value: 'max', clamped: false, source: 'chat' });
    })
);

results.push(
    await runCase('off: only a toggle model switches thinking off', async () => {
        expectResolution('deepseek-flash', 'off', { mode: 'off', value: null, clamped: false, source: 'chat' });
        expectResolution('mimo-v2.6-flash', 'off', { mode: 'off', value: null, clamped: false, source: 'chat' });
        expectResolution('gemini-4-hydrogen', 'off', {
            mode: 'default',
            value: null,
            clamped: false,
            source: 'model-default',
        });
        expectResolution('gpt-6-luna', 'off', { mode: 'default', value: null, clamped: false, source: 'model-default' });
    })
);

results.push(
    await runCase('a toggle-only model ignores a graded setting instead of guessing a level', async () => {
        expectResolution('mimo-v2.6-flash', 'xhigh', {
            mode: 'default',
            value: null,
            clamped: false,
            source: 'model-default',
        });
        expectResolution('mimo-v2.6-flash', 'low', { mode: 'default', value: null, clamped: false, source: 'model-default' });
        // An invalid stored value (a hand-edited row) is not sent
        expectResolution('gemini-4-hydrogen', 'turbo', {
            mode: 'default',
            value: null,
            clamped: false,
            source: 'model-default',
        });
    })
);

results.push(
    await runCase('unknown models fall back to code: the platform keeps today\'s request', async () => {
        for (const requested of [null, 'off', 'xhigh', 'low', 'turbo']) {
            expectResolution('no-such-model', requested, {
                mode: 'default',
                value: null,
                clamped: false,
                source: 'code',
            });
            const request = thinkingRequestOf('no-such-model', requested);
            expect(
                JSON.stringify(request.platform) === '{}',
                `no-such-model / ${String(requested)}: no platform field (got ${JSON.stringify(request.platform)})`
            );
            expect(
                request.facts.requested === requested && request.facts.sent === null && request.facts.fallback === null,
                'the facts keep the request and send nothing explicit'
            );
        }
        // A model whose capabilities exist but whose reasoning section is unknown
        // is treated the same way: no data, no field.
        const hydrogen = capabilitySeedOf('gemini-4-hydrogen');
        if (hydrogen === null) throw new Error('no hydrogen seed');
        const withoutReasoning: ModelCatalogCapabilities = { ...hydrogen, reasoning: undefined };
        setModelCatalog(
            seedModelCatalogEntries().map((entry) =>
                entry.id === 'gemini-4-hydrogen' ? { ...entry, capabilities: withoutReasoning } : entry
            )
        );
        expectResolution('gemini-4-hydrogen', 'xhigh', { mode: 'default', value: null, clamped: false, source: 'code' });
        setModelCatalog(seedModelCatalogEntries());
    })
);

results.push(
    await runCase('the request fragment and the metrics facts share one resolution', async () => {
        expect(
            requestJson('gemini-4-hydrogen', null) ===
                JSON.stringify({
                    platform: { thinkingEffort: { mode: 'default', value: null } },
                    facts: { requested: null, sent: null, fallback: null },
                }),
            `default: the platform is told not to override the vendor default (got ${requestJson('gemini-4-hydrogen', null)})`
        );
        expect(
            requestJson('gemini-4-hydrogen', 'xhigh') ===
                JSON.stringify({
                    platform: { thinkingEffort: { mode: 'explicit', value: 'xhigh' } },
                    facts: { requested: 'xhigh', sent: 'xhigh', fallback: null },
                }),
            `explicit (got ${requestJson('gemini-4-hydrogen', 'xhigh')})`
        );
        expect(
            requestJson('gemini-4-argon', 'xhigh') ===
                JSON.stringify({
                    platform: { thinkingEffort: { mode: 'explicit', value: 'high' } },
                    facts: { requested: 'xhigh', sent: 'high', fallback: 'xhigh->high' },
                }),
            `clamp records the chain (got ${requestJson('gemini-4-argon', 'xhigh')})`
        );
        expect(
            requestJson('deepseek-flash', 'off') ===
                JSON.stringify({
                    platform: { thinkingEffort: { mode: 'off', value: null } },
                    facts: { requested: 'off', sent: 'off', fallback: null },
                }),
            `off (got ${requestJson('deepseek-flash', 'off')})`
        );
        expect(
            requestJson('gemini-4-hydrogen', 'off') ===
                JSON.stringify({
                    platform: { thinkingEffort: { mode: 'default', value: null } },
                    facts: { requested: 'off', sent: null, fallback: null },
                }),
            `off on a non-toggle model asks for the vendor default (got ${requestJson('gemini-4-hydrogen', 'off')})`
        );
        expect(
            requestJson('mimo-v2.6-flash', 'xhigh') ===
                JSON.stringify({
                    platform: { thinkingEffort: { mode: 'default', value: null } },
                    facts: { requested: 'xhigh', sent: null, fallback: null },
                }),
            `a graded setting on a toggle-only model is not sent (got ${requestJson('mimo-v2.6-flash', 'xhigh')})`
        );
        expect(
            requestJson('no-such-model', 'xhigh') ===
                JSON.stringify({
                    platform: {},
                    facts: { requested: 'xhigh', sent: null, fallback: null },
                }),
            `an unknown model's request is unchanged (got ${requestJson('no-such-model', 'xhigh')})`
        );
    })
);

results.push(
    await runCase('the continue check names what changed: the chat setting or the model data', async () => {
        const requestFactsOf = (thinkingEffort: ThinkingEffortValue | null, sent: string | null): ResumeRequestFacts => ({
            model: 'gemini-4-hydrogen',
            systemPrompt: 'prompt',
            toolDefinitionsJson: '[]',
            thinkingEffort,
            thinkingEffortSent: sent,
        });
        const changeOf = (setting: ThinkingEffortValue | null, request: ResumeRequestFacts) =>
            thinkingEffortChangeOf({ thinkingEffort: setting }, request);
        const noticeOf = (setting: ThinkingEffortValue | null, request: ResumeRequestFacts) =>
            thinkingEffortRefusalNoticeOf({ thinkingEffort: setting }, request);

        expect(changeOf('high', requestFactsOf('high', 'high')) === null, 'the same setting may continue');
        expect(noticeOf('high', requestFactsOf('high', 'high')) === null, 'no notice for the same request shape');
        expect(changeOf(null, requestFactsOf(null, null)) === null, 'no setting on both sides may continue');
        expect(noticeOf(null, requestFactsOf(null, null)) === null, 'and no notice either');

        expect(
            changeOf('xhigh', requestFactsOf('high', 'high')) === 'setting-changed',
            'a changed graded setting is the chat setting'
        );
        expect(
            noticeOf('xhigh', requestFactsOf('high', 'high')) === THINKING_EFFORT_CHANGED_NOTICE,
            'it gets the change-it-back notice'
        );
        expect(
            changeOf('off', requestFactsOf(null, null)) === 'setting-changed',
            'turning thinking off is the chat setting'
        );
        expect(
            changeOf(null, requestFactsOf('off', 'off')) === 'setting-changed',
            'turning thinking back on is the chat setting'
        );

        // Same stored setting, but the model's data now resolves to another level
        expect(
            changeOf('xhigh', requestFactsOf('xhigh', 'high')) === 'model-data-changed',
            'a resolved level that changed since the interrupt is the model data'
        );
        expect(
            noticeOf('xhigh', requestFactsOf('xhigh', 'high')) === THINKING_EFFORT_DATA_CHANGED_NOTICE,
            'it gets the retry-only notice instead of asking to change the setting back'
        );
        expect(
            changeOf('high', requestFactsOf('high', 'xhigh')) === 'model-data-changed',
            'a drift in either direction is the model data'
        );

        expect(
            THINKING_EFFORT_CHANGED_NOTICE.includes('思考档位已修改') && THINKING_EFFORT_CHANGED_NOTICE.includes('重试'),
            `the setting notice asks to restore the setting or retry (got ${THINKING_EFFORT_CHANGED_NOTICE})`
        );
        expect(
            THINKING_EFFORT_DATA_CHANGED_NOTICE.includes('模型的思考档位数据已变化') &&
                THINKING_EFFORT_DATA_CHANGED_NOTICE.includes('点重试可继续'),
            `the data notice only offers a retry (got ${THINKING_EFFORT_DATA_CHANGED_NOTICE})`
        );
    })
);

reportResults(results);
