/**
 * Offline cases for the Mini App side of the owner's model catalog page: the
 * pure formatting module the page renders with (effort labels, default/toggle
 * wording, modality and API lists, provenance combination, badges and the header
 * line). No browser needed; the page component itself is covered by
 * `pnpm typecheck webapp`.
 *
 * Run: npx tsx scripts/offline/webapp-model-catalog.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import type { ModelCatalogEntryView } from '../../webapp/src/api/types.ts';
import {
    apisTextOf,
    capabilityFactsOf,
    defaultTextOf,
    effortLabelOf,
    effortsTextOf,
    fieldProvenanceFactsOf,
    laneFingerprintsTextOf,
    modalityListTextOf,
    modelCatalogBadgesOf,
    modelCatalogMetaTextOf,
    modelConfidenceLabelOf,
    modelReconciliationFactsOf,
    modelSourceLabelOf,
    modelTraitsOriginLabelOf,
    reconciliationSummaryTextOf,
    toggleTextOf,
} from '../../webapp/src/pages/model-catalog/model-catalog-format.ts';

/** A hydrogen-shaped row: graded efforts, no toggle, probe-sourced reasoning */
const entryFixture = (overrides: Partial<ModelCatalogEntryView> = {}): ModelCatalogEntryView => ({
    id: 'gemini-4-hydrogen',
    label: 'Gemini 4 Hydrogen',
    platform: 'gemini',
    enabled: true,
    source: 'manual',
    checkedOn: '2026-11-13',
    confidence: 'high',
    traitsOrigin: 'catalog',
    capabilities: {
        schema: 1,
        kind: 'chat',
        vision: true,
        imageOutput: false,
        tools: true,
        reasoningEffort: ['low', 'medium', 'high', 'xhigh'],
        contextTokens: 1_048_576,
        outputTokens: 65_536,
        modalities: { input: ['text', 'image'], output: ['text'] },
        reasoning: {
            supported: true,
            toggle: false,
            efforts: ['low', 'medium', 'high', 'xhigh'],
            defaultEffort: 'high',
            defaultEnabled: null,
            source: 'probe',
            checkedOn: '2026-11-13',
            confidence: 'high',
        },
        apis: { 'generate-content': { reasoning: true, tools: true } },
        source: 'code',
        checkedOn: '2026-11-01',
        confidence: 'medium',
    },
    ...overrides,
});

const results: CaseResult[] = [];

results.push(
    await runCase('efforts: Chinese words, empty and unknown values', () => {
        expect(effortsTextOf(['low', 'medium', 'high', 'xhigh']) === '低/中/高/极高', 'the four graded efforts');
        expect(effortsTextOf([]) === '无分档', 'an empty list is a toggle-only model');
        expect(effortsTextOf(undefined) === '未知', 'undefined is unknown');
        expect(effortLabelOf('xx') === 'xx', 'an unknown word is shown as-is');
    })
);

results.push(
    await runCase('default and toggle wording for graded and toggle models', () => {
        const graded = entryFixture().capabilities.reasoning;
        expect(defaultTextOf(graded) === '高', 'graded default is its label');
        expect(toggleTextOf(graded) === '仅支持开启', 'toggle=false with support means always on');
        const toggleOn = entryFixture({
            capabilities: { ...entryFixture().capabilities, reasoning: { supported: true, toggle: true, defaultEnabled: true } },
        }).capabilities.reasoning;
        expect(defaultTextOf(toggleOn) === '思考开', 'toggle model default on');
        expect(toggleTextOf(toggleOn) === '可开关', 'toggle model can be switched');
        const toggleOff = entryFixture({
            capabilities: { ...entryFixture().capabilities, reasoning: { supported: true, toggle: true, defaultEnabled: false } },
        }).capabilities.reasoning;
        expect(defaultTextOf(toggleOff) === '思考关', 'toggle model default off');
        const toggleUnknown = entryFixture({
            capabilities: { ...entryFixture().capabilities, reasoning: { supported: true, toggle: true, defaultEnabled: null } },
        }).capabilities.reasoning;
        expect(defaultTextOf(toggleUnknown) === '由模型决定', 'unknown toggle default is named');
        expect(defaultTextOf(undefined) === '未知', 'no reasoning data is unknown');
        expect(toggleTextOf({ supported: false }) === '不支持思考', 'unsupported thinking');
    })
);

results.push(
    await runCase('capability facts follow the owner’s reading order', () => {
        const facts = capabilityFactsOf(entryFixture());
        const byLabel = new Map(facts.map((fact) => [fact.label, fact.value]));
        expect(byLabel.get('类型') === '文本', 'kind label');
        expect(byLabel.get('思考档位') === '低/中/高/极高', 'efforts');
        expect(byLabel.get('默认档位') === '高', 'default');
        expect(byLabel.get('上下文上限') === '1.05M', 'context limit formatted');
        expect(byLabel.get('输出上限') === '65.5k', 'output limit formatted');
        expect(byLabel.get('输入模态') === '文本、图片', 'input modalities');
        expect(byLabel.get('输出模态') === '文本', 'output modalities');
        expect(byLabel.get('可用 API') === 'generate-content', 'api list');
        expect(byLabel.get('运行时来源') === '目录数据', 'traits origin label');
        expect(byLabel.get('图片输入') === '支持', 'vision');
        expect(!byLabel.has('来源'), 'row-level source column replaced by field-level provenance');

        const legacyProv = fieldProvenanceFactsOf(entryFixture());
        expect(
            legacyProv.some((fact) => fact.field === 'reasoning' && fact.summary.includes('probe')),
            'legacy fallback shows reasoning provenance'
        );

        const fieldEntry = entryFixture({
            capabilities: {
                ...entryFixture().capabilities,
                laneFingerprints: { gemini: 'vertex-adc@global' },
                provenance: {
                    'reasoning.efforts': { source: 'probe', checkedOn: '2026-11-13', lane: 'vertex-adc@global' },
                    'reasoning.defaultEffort': { source: 'official', checkedOn: '2026-11-14' },
                    toolsMixing: { source: 'traffic', checkedOn: '2026-11-20', lane: 'vertex-adc@global' },
                },
            },
        });
        const fieldFacts = capabilityFactsOf(fieldEntry);
        const fieldMap = new Map(fieldFacts.map((fact) => [fact.label, fact.value]));
        expect(
            (fieldMap.get('通道指纹') ?? '').includes('vertex-adc@global'),
            `lane fingerprints rendered (got ${String(fieldMap.get('通道指纹'))})`
        );
        const provFacts = fieldProvenanceFactsOf(fieldEntry);
        expect(
            provFacts.some((fact) => fact.label === '思考档位' && fact.summary.includes('probe · 2026-11-13 · 通道 vertex-adc@global')),
            'field-level provenance renders source, date and lane'
        );
        expect(
            provFacts.some((fact) => fact.label === '工具混用' && fact.summary.includes('线上流量')),
            'traffic source renders in field provenance'
        );
        expect(laneFingerprintsTextOf(undefined) === null, 'missing lane fingerprints returns null');
    })
);

results.push(
    await runCase('modality, API and header lines', () => {
        expect(modalityListTextOf({ input: ['text', 'image'] }, 'input') === '文本、图片', 'list of modalities');
        expect(modalityListTextOf({ input: [] }, 'input') === '无', 'empty modalities');
        expect(modalityListTextOf(undefined, 'output') === '未知', 'unknown modalities');
        expect(apisTextOf({ responses: {}, 'chat-completions': {} }) === 'responses、chat-completions', 'API names');
        expect(apisTextOf(undefined) === '未知', 'unknown APIs');
        const meta = modelCatalogMetaTextOf({
            catalogVersion: 'mabc123-13',
            pendingProposals: 2,
            models: [entryFixture(), entryFixture({ id: 'gpt-6-luna' }), entryFixture({ id: 'deepseek-flash' })],
        });
        expect(meta.includes('目录 mabc123-13'), `meta names the version (got ${meta})`);
        expect(meta.includes('待确认能力提案 2 条'), 'meta names the pending count');
        expect(meta.includes('3 个模型'), 'meta names the row count');
        const metaWithRefs = modelCatalogMetaTextOf({
            catalogVersion: 'mabc123-13',
            pendingProposals: 1,
            models: [entryFixture(), entryFixture({ id: 'gemini-3.8-flash', enabled: false })],
        });
        expect(metaWithRefs.includes('菜单 1 + 参考行 1 个模型'), `meta distinguishes menu vs reference rows (got ${metaWithRefs})`);
    })
);

results.push(
    await runCase('badges and reconciliation formatters handle reference rows, traffic and diffs', () => {
        expect(modelCatalogBadgesOf(entryFixture()).includes('probe 实测'), 'probe reasoning is flagged');
        expect(modelCatalogBadgesOf(entryFixture({ enabled: false })).includes('参考行'), 'disabled/reference row is flagged');
        const trafficEntry = entryFixture({
            capabilities: {
                ...entryFixture().capabilities,
                provenance: { 'reasoning.efforts': { source: 'traffic', checkedOn: '2026-11-20' } },
            },
        });
        expect(modelCatalogBadgesOf(trafficEntry).includes('线上流量修正'), 'traffic provenance badge shown');
        const image = entryFixture({
            capabilities: { ...entryFixture().capabilities, kind: 'image', imageOutput: true },
        });
        expect(modelCatalogBadgesOf(image).includes('可出图'), 'image output is flagged');
        expect(modelTraitsOriginLabelOf('code') === '代码兜底', 'traits origin label');
        expect(modelSourceLabelOf('models-dev') === 'models.dev', 'source label');
        expect(modelSourceLabelOf('traffic') === '线上流量', 'traffic source label');
        expect(modelConfidenceLabelOf('low') === '低', 'confidence label');

        const cleanRec = reconciliationSummaryTextOf({ catalogVersion: 'm1', rows: [], totalDiffs: 0 });
        expect(cleanRec.includes('0 项差异'), 'clean reconciliation summary');
        const diffRecText = reconciliationSummaryTextOf({
            catalogVersion: 'm2',
            totalDiffs: 1,
            rows: [
                {
                    model: 'gemini-4-hydrogen',
                    platform: 'gemini',
                    origin: 'catalog',
                    inCatalog: true,
                    enabled: true,
                    diffCount: 1,
                    entries: [
                        {
                            field: 'imageOutput',
                            data: true,
                            code: false,
                            runtime: true,
                            origin: 'data',
                            differs: true,
                        },
                    ],
                },
            ],
        });
        expect(diffRecText.includes('1 项差异'), `diff reconciliation summary (got ${diffRecText})`);
        const rowDiffs = modelReconciliationFactsOf({
            model: 'gemini-4-hydrogen',
            platform: 'gemini',
            origin: 'catalog',
            inCatalog: true,
            enabled: true,
            diffCount: 1,
            entries: [
                { field: 'imageOutput', data: true, code: false, runtime: true, origin: 'data', differs: true },
                { field: 'imageInput', data: true, code: true, runtime: true, origin: 'data', differs: false },
            ],
        });
        expect(rowDiffs.length === 1 && rowDiffs[0]?.label === '图片输出', 'only differing fields returned');
        expect(rowDiffs[0]?.detail.includes('目录 是 · 代码 否 → 目录生效'), `reconciliation diff text (got ${String(rowDiffs[0]?.detail)})`);
    })
);

reportResults(results);
