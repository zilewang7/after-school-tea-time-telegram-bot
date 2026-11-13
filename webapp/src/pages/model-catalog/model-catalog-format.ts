/**
 * Text rules of the owner's read-only model catalog page: effort labels, source
 * and confidence names, modality/API lists and the provenance of one row. Pure
 * functions, so the offline cases can check the wording without a browser.
 *
 * The labels mirror the server's closed sets (thinking-effort design §1.1/§4.3);
 * an unknown value falls back to the raw string instead of disappearing.
 */
import type {
    ModelCapabilitiesView,
    ModelCapabilityModalities,
    ModelCapabilityReasoning,
    ModelCatalogEntryView,
    ModelCatalogKind,
    ModelCatalogResponse,
    ModelModalityName,
    ModelTraitsOrigin,
} from '../../api';
import { formatCount, formatTokens } from '../../format-metrics';
import { THINKING_EFFORT_LABELS } from '../../thinking-effort';

/** Where a catalog row's values came from */
export const MODEL_CATALOG_SOURCE_LABELS: Readonly<Record<string, string>> = {
    code: '代码 seed',
    'models-dev': 'models.dev',
    manual: '人工',
    official: '官方文档',
    probe: 'probe',
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

export const modelSourceLabelOf = (source: string): string => MODEL_CATALOG_SOURCE_LABELS[source] ?? source;

export const modelConfidenceLabelOf = (confidence: string): string =>
    MODEL_CATALOG_CONFIDENCE_LABELS[confidence] ?? confidence;

export const modelTraitsOriginLabelOf = (origin: ModelTraitsOrigin): string => MODEL_TRAITS_ORIGIN_LABELS[origin];

export const modelKindLabelOf = (kind: ModelCatalogKind): string => MODEL_KIND_LABELS[kind];

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

/** The row's own provenance plus the reasoning section's, when they differ */
const combinedProvenanceOf = (
    entry: ModelCatalogEntryView,
    part: 'source' | 'checkedOn' | 'confidence'
): string => {
    const rowValue =
        part === 'source'
            ? modelSourceLabelOf(entry.source)
            : part === 'checkedOn'
              ? entry.checkedOn
              : modelConfidenceLabelOf(entry.confidence);
    const reasoningValue =
        part === 'source'
            ? entry.capabilities.reasoning?.source
            : part === 'checkedOn'
              ? entry.capabilities.reasoning?.checkedOn
              : entry.capabilities.reasoning?.confidence;
    if (reasoningValue === undefined) return rowValue;
    const reasoningText = part === 'confidence' ? modelConfidenceLabelOf(reasoningValue) : reasoningValue;
    return reasoningText === rowValue ? rowValue : `${rowValue}（思考 ${reasoningText}）`;
};

export interface CapabilityFact {
    readonly label: string;
    readonly value: string;
}

/** The labeled rows one model card shows; order is the reading order */
export const capabilityFactsOf = (entry: ModelCatalogEntryView): readonly CapabilityFact[] => {
    const { capabilities } = entry;
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
        { label: '来源', value: combinedProvenanceOf(entry, 'source') },
        { label: '核对日期', value: combinedProvenanceOf(entry, 'checkedOn') },
        { label: '置信', value: combinedProvenanceOf(entry, 'confidence') },
        { label: '运行时来源', value: modelTraitsOriginLabelOf(entry.traitsOrigin) },
    ];
};

/** The page header's one line: catalog content version, pending proposals, row count */
export const modelCatalogMetaTextOf = (
    response: Pick<ModelCatalogResponse, 'catalogVersion' | 'pendingProposals' | 'models'>
): string =>
    `目录 ${response.catalogVersion} · 待确认能力提案 ${formatCount(response.pendingProposals)} 条 · ${formatCount(
        response.models.length
    )} 个模型`;

/** The two provenance words the card header shows as badges */
export const modelCatalogBadgesOf = (entry: ModelCatalogEntryView): readonly string[] => {
    const badges: string[] = [modelKindLabelOf(entry.capabilities.kind)];
    if (!entry.enabled) badges.push('未启用');
    if (entry.capabilities.imageOutput) badges.push('可出图');
    if (entry.capabilities.reasoning?.source === 'probe') badges.push('probe 实测');
    return badges;
};
