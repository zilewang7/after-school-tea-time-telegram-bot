/**
 * Text rules of the owner's read-only model catalog page: effort labels, source
 * and confidence names, modality/API lists, field-level provenance, per-platform
 * lane fingerprints, and the code-vs-data reconciliation summary. Pure functions,
 * so the offline cases can check the wording without a browser.
 */
import type {
    CatalogTraitsReconciliation,
    ModelCapabilitiesView,
    ModelCapabilityModalities,
    ModelCapabilityReasoning,
    ModelCatalogEntryView,
    ModelCatalogKind,
    ModelCatalogResponse,
    ModelModalityName,
    ModelTraitReconciliationRow,
    ModelTraitsOrigin,
    PlatformLaneFingerprints,
    ReconciledTraitEntry,
    ReconciledTraitField,
} from '../../api';
import { formatCount, formatTokens, platformLabel } from '../../format-metrics';
import { THINKING_EFFORT_LABELS } from '../../thinking-effort';

/** Where a capability value came from */
export const MODEL_CATALOG_SOURCE_LABELS: Readonly<Record<string, string>> = {
    code: '代码 seed',
    'models-dev': 'models.dev',
    manual: '人工',
    official: '官方文档',
    probe: 'probe',
    traffic: '线上流量',
};

export const MODEL_CATALOG_CONFIDENCE_LABELS: Readonly<Record<string, string>> = {
    high: '高',
    medium: '中',
    low: '低',
};

/** What the runtime resolves the model's traits from */
export const MODEL_TRAITS_ORIGIN_LABELS: Readonly<Record<ModelTraitsOrigin, string>> = {
    catalog: '目录数据',
    seed: '代码 seed',
    code: '代码兜底',
};

export const MODEL_KIND_LABELS: Readonly<Record<ModelCatalogKind, string>> = {
    chat: '文本',
    image: '图像',
};

export const MODEL_MODALITY_LABELS: Readonly<Record<ModelModalityName, string>> = {
    text: '文本',
    image: '图片',
    audio: '音频',
    video: '视频',
    pdf: 'PDF',
};

export const PROVENANCE_FIELD_LABELS: Readonly<Record<string, string>> = {
    kind: '类型',
    vision: '图片输入',
    imageOutput: '图片输出',
    tools: '工具调用',
    contextTokens: '上下文上限',
    outputTokens: '输出上限',
    'modalities.input': '输入模态',
    'modalities.output': '输出模态',
    'reasoning.supported': '思考能力',
    'reasoning.toggle': '思考开关',
    'reasoning.efforts': '思考档位',
    'reasoning.defaultEffort': '默认档位',
    'reasoning.defaultEnabled': '默认思考',
    apis: '可用 API',
    toolsMixing: '工具混用',
    'nativeTools.imageSearchGrounding': '图像搜索',
};

export const RECONCILED_FIELD_LABELS: Readonly<Record<ReconciledTraitField, string>> = {
    imageOutput: '图片输出',
    imageInput: '图片输入',
    mediaInput: '音视频输入',
    clientTools: '客户端工具',
    geminiToolsMixing: 'Gemini 工具混用',
    imageSearchGrounding: '图像搜索 Grounding',
    xhighThinking: '支持 xhigh 思考',
    outputTokens: '输出上限',
};

export const modelSourceLabelOf = (source: string): string => MODEL_CATALOG_SOURCE_LABELS[source] ?? source;

export const modelConfidenceLabelOf = (confidence: string): string =>
    MODEL_CATALOG_CONFIDENCE_LABELS[confidence] ?? confidence;

export const modelTraitsOriginLabelOf = (origin: ModelTraitsOrigin): string => MODEL_TRAITS_ORIGIN_LABELS[origin];

export const modelKindLabelOf = (kind: ModelCatalogKind): string => MODEL_KIND_LABELS[kind];

export const reconciledFieldLabelOf = (field: ReconciledTraitField): string => RECONCILED_FIELD_LABELS[field] ?? field;

/** One effort value in Chinese; an unknown word is shown as-is */
export const effortLabelOf = (effort: string): string => THINKING_EFFORT_LABELS[effort] ?? effort;

/** Participation of the row's reasoning data in one line, e.g. "低/中/高/极高" */
export const effortsTextOf = (efforts: readonly string[] | undefined): string => {
    if (efforts === undefined) return '未知';
    if (efforts.length === 0) return '无分档';
    return efforts.map((effort) => effortLabelOf(effort)).join('/');
};

/** The vendor default: a graded effort, a toggle state, or unknown */
export const defaultTextOf = (reasoning: ModelCapabilityReasoning | undefined): string => {
    if (reasoning === undefined) return '未知';
    if (reasoning.defaultEffort !== undefined && reasoning.defaultEffort !== null) {
        return effortLabelOf(reasoning.defaultEffort);
    }
    if (reasoning.toggle === true) {
        if (reasoning.defaultEnabled === true) return '思考开';
        if (reasoning.defaultEnabled === false) return '思考关';
        return '由模型决定';
    }
    return '未知';
};

/** Can the user turn thinking off/on at all? */
export const toggleTextOf = (reasoning: ModelCapabilityReasoning | undefined): string => {
    if (reasoning === undefined) return '未知';
    if (!reasoning.supported) return '不支持思考';
    if (reasoning.toggle === true) return '可开关';
    if (reasoning.toggle === false) return '仅支持开启';
    return '未知';
};

const listTextOf = (values: readonly string[] | undefined, labels: Readonly<Record<string, string>>, empty: string): string => {
    if (values === undefined) return '未知';
    if (values.length === 0) return empty;
    return values.map((value) => labels[value] ?? value).join('、');
};

/** "文本、图片"; undefined = unknown, empty = the section was not asserted */
export const modalityListTextOf = (
    modalities: ModelCapabilityModalities | undefined,
    direction: 'input' | 'output'
): string => listTextOf(modalities?.[direction], MODEL_MODALITY_LABELS, '无');

/** "responses、chat-completions"; undefined = unknown */
export const apisTextOf = (apis: ModelCapabilitiesView['apis']): string => {
    if (apis === undefined) return '未知';
    const names = Object.keys(apis);
    return names.length === 0 ? '无' : names.join('、');
};

/** Per-platform lane fingerprints in one line, or null when none exist */
export const laneFingerprintsTextOf = (fingerprints: PlatformLaneFingerprints | undefined): string | null => {
    if (fingerprints === undefined) return null;
    const entries = Object.entries(fingerprints).filter(
        (pair): pair is [string, string] => typeof pair[1] === 'string' && pair[1] !== ''
    );
    if (entries.length === 0) return null;
    return entries.map(([platform, lane]) => `${platformLabel(platform)} ${lane}`).join(' · ');
};

export interface FieldProvenanceFact {
    readonly field: string;
    readonly label: string;
    readonly summary: string;
}

const formatProvenanceEntry = (
    source: string,
    checkedOn?: string,
    lane?: string
): string => {
    const parts = [modelSourceLabelOf(source)];
    if (checkedOn !== undefined && checkedOn !== '') parts.push(checkedOn);
    if (lane !== undefined && lane !== '') parts.push(`通道 ${lane}`);
    return parts.join(' · ');
};

/** Field-level provenance list; falls back to legacy row/reasoning provenance when absent */
export const fieldProvenanceFactsOf = (entry: ModelCatalogEntryView): readonly FieldProvenanceFact[] => {
    const { capabilities } = entry;
    const map = capabilities.provenance;
    if (map !== undefined) {
        const facts: FieldProvenanceFact[] = [];
        for (const [field, prov] of Object.entries(map)) {
            if (prov === undefined) continue;
            facts.push({
                field,
                label: PROVENANCE_FIELD_LABELS[field] ?? field,
                summary: formatProvenanceEntry(prov.source, prov.checkedOn, prov.lane),
            });
        }
        if (facts.length > 0) return facts;
    }
    const facts: FieldProvenanceFact[] = [
        {
            field: 'row',
            label: '基础能力',
            summary: formatProvenanceEntry(capabilities.source ?? entry.source, capabilities.checkedOn ?? entry.checkedOn),
        },
    ];
    if (capabilities.reasoning?.source !== undefined) {
        facts.push({
            field: 'reasoning',
            label: '思考能力',
            summary: formatProvenanceEntry(
                capabilities.reasoning.source,
                capabilities.reasoning.checkedOn
            ),
        });
    }
    return facts;
};

export interface CapabilityFact {
    readonly label: string;
    readonly value: string;
}

/** The labeled rows one model card shows; order is the reading order */
export const capabilityFactsOf = (entry: ModelCatalogEntryView): readonly CapabilityFact[] => {
    const { capabilities } = entry;
    const lanes = laneFingerprintsTextOf(capabilities.laneFingerprints);
    return [
        { label: '类型', value: modelKindLabelOf(capabilities.kind) },
        { label: '思考档位', value: effortsTextOf(capabilities.reasoning?.efforts) },
        { label: '默认档位', value: defaultTextOf(capabilities.reasoning) },
        { label: '思考开关', value: toggleTextOf(capabilities.reasoning) },
        { label: '图片输入', value: capabilities.vision ? '支持' : '不支持' },
        { label: '上下文上限', value: formatTokens(capabilities.contextTokens) },
        { label: '输出上限', value: formatTokens(capabilities.outputTokens) },
        { label: '输入模态', value: modalityListTextOf(capabilities.modalities, 'input') },
        { label: '输出模态', value: modalityListTextOf(capabilities.modalities, 'output') },
        { label: '可用 API', value: apisTextOf(capabilities.apis) },
        ...(lanes === null ? [] : [{ label: '通道指纹', value: lanes }]),
        { label: '运行时来源', value: modelTraitsOriginLabelOf(entry.traitsOrigin) },
    ];
};

/** The page header's one line: catalog content version, pending proposals, menu vs reference counts */
export const modelCatalogMetaTextOf = (
    response: Pick<ModelCatalogResponse, 'catalogVersion' | 'pendingProposals' | 'models'>
): string => {
    const menuCount = response.models.filter((entry) => entry.enabled).length;
    const referenceCount = response.models.length - menuCount;
    const countText =
        referenceCount > 0
            ? `菜单 ${formatCount(menuCount)} + 参考行 ${formatCount(referenceCount)} 个模型`
            : `${formatCount(response.models.length)} 个模型`;
    return `目录 ${response.catalogVersion} · 待确认能力提案 ${formatCount(response.pendingProposals)} 条 · ${countText}`;
};

const hasProbeOrTraffic = (capabilities: ModelCapabilitiesView, source: 'probe' | 'traffic'): boolean => {
    if (capabilities.reasoning?.source === source || capabilities.source === source) return true;
    if (capabilities.provenance === undefined) return false;
    return Object.values(capabilities.provenance).some((entry) => entry?.source === source);
};

/** Badges distinguishing menu rows vs reference rows, kind, image output, and probe/traffic sources */
export const modelCatalogBadgesOf = (entry: ModelCatalogEntryView): readonly string[] => {
    const badges: string[] = [modelKindLabelOf(entry.capabilities.kind)];
    if (!entry.enabled) badges.push('参考行');
    if (entry.capabilities.imageOutput) badges.push('可出图');
    if (hasProbeOrTraffic(entry.capabilities, 'probe')) badges.push('probe 实测');
    if (hasProbeOrTraffic(entry.capabilities, 'traffic')) badges.push('线上流量修正');
    return badges;
};

const traitValueTextOf = (value: boolean | number | null): string => {
    if (value === null) return '未断言';
    if (typeof value === 'boolean') return value ? '是' : '否';
    return formatTokens(value);
};

/** Summary text for the code-vs-data reconciliation table */
export const reconciliationSummaryTextOf = (reconciliation: CatalogTraitsReconciliation): string => {
    if (reconciliation.totalDiffs === 0) {
        return `对账表（${reconciliation.catalogVersion}）：${formatCount(reconciliation.rows.length)} 个模型目录与代码完全一致（0 项差异）`;
    }
    const diffModels = reconciliation.rows.filter((row) => row.diffCount > 0).length;
    return `对账表（${reconciliation.catalogVersion}）：${formatCount(diffModels)} / ${formatCount(
        reconciliation.rows.length
    )} 个模型共 ${formatCount(reconciliation.totalDiffs)} 项差异`;
};

export interface ReconciliationDiffFact {
    readonly field: ReconciledTraitField;
    readonly label: string;
    readonly detail: string;
}

const formatTraitOrigin = (origin: ReconciledTraitEntry['origin']): string =>
    origin === 'data' ? '目录生效' : '代码生效';

/** Format one model's differing reconciliation entries (`目录 X / 代码 Y → 运行时 Z`) */
export const modelReconciliationFactsOf = (row: ModelTraitReconciliationRow): readonly ReconciliationDiffFact[] =>
    row.entries
        .filter((entry) => entry.differs)
        .map((entry) => ({
            field: entry.field,
            label: reconciledFieldLabelOf(entry.field),
            detail: `目录 ${traitValueTextOf(entry.data)} · 代码 ${traitValueTextOf(entry.code)} → ${formatTraitOrigin(
                entry.origin
            )}（${traitValueTextOf(entry.runtime)}）`,
        }));
