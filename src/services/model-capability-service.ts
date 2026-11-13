/**
 * Capability proposals: storage and lifecycle of one model's proposed
 * `model_catalog.capabilities` change (thinking-effort design 2026-1113-1742
 * §1.3/§2.4).
 *
 * The price watcher and the owner's `/probe import` both write here and never
 * touch the catalog directly: a proposal waits for the owner's button in a
 * private chat, and only `applyCapabilityProposals` writes the catalog row
 * (inside one transaction, with a `settings_audit` entry). Every function is
 * tolerant given by the HTTP-free design: bad JSON in one row is logged and
 * skipped at read time and refuses the whole apply at write time.
 *
 * The table is `model_capability_proposals` (its own DTO); this module is the
 * only writer, mirroring `model-price-service` for the price half.
 */
import { Op } from '@sequelize/core';
import { sequelize } from '../db/config.js';
import { ModelCapabilityProposal } from '../db/modelCapabilityProposalDTO.js';
import { ModelCatalogEntryRow } from '../db/modelCatalogDTO.js';
import { writeSettingsAudit } from '../db/queries/settings-audit.js';
import {
    emptyModelCapabilities,
    MODEL_APIS,
    normalizeModelCapabilities,
    type ModelCatalogCapabilities,
    type ModelCatalogModalities,
    type ModelCapabilitySource,
} from '../config/model-capabilities.js';
import { isJsonObject } from '../shared/json-object.js';
import { loadModelCatalog } from './model-catalog-service.js';
import type { CapabilityProposalDraft } from './capability-catalog-types.js';

/** Pending proposals older than this stop being actionable */
const PROPOSAL_TTL_MS = 14 * 24 * 3600 * 1000;

/** A proposal as the approval UI sees it (payload/baseline already parsed) */
export interface CapabilityProposalView {
    readonly id: number;
    readonly model: string;
    readonly payload: ModelCatalogCapabilities;
    readonly baseline: ModelCatalogCapabilities | null;
    readonly detectedAt: Date;
    readonly status: string;
    readonly runId: number | null;
    readonly messageId: number | null;
    readonly note: string | null;
}

/** One changed field, rendered in the approval message and by the rewrite text */
export interface CapabilityFieldChangeView {
    /** Stable path, e.g. `reasoning.efforts` (the compile draft uses the same id) */
    readonly field: string;
    /** Chinese label the owner sees, e.g. `思考档位` */
    readonly label: string;
    readonly oldValue: string;
    readonly newValue: string;
}

export interface CapabilityProposalInput {
    readonly model: string;
    readonly payload: ModelCatalogCapabilities;
    readonly baseline: ModelCatalogCapabilities | null;
    readonly note: string;
    /** YYYY-MM-DD of the check; the fallback note uses it when `note` is blank */
    readonly checkedOn: string;
}

/** How one approved proposal actually ended */
export type CapabilityApplyOutcome = 'applied' | 'superseded' | 'unchanged';

/** One row the apply looked at, with what it did to it */
export interface CapabilityApplyDecision {
    readonly id: number;
    readonly model: string;
    readonly outcome: CapabilityApplyOutcome;
}

export interface CapabilityApplyResult {
    /** Catalog rows written and audited */
    readonly applied: number;
    /** Proposals whose baseline no longer matches the catalog, or whose row is gone */
    readonly superseded: number;
    /** Approved payloads that equal the current values (nothing to write) */
    readonly unchanged: number;
    /** Ids that were already decided (or do not exist): nothing was attempted */
    readonly skipped: number;
    readonly decisions: readonly CapabilityApplyDecision[];
}

/** One draft a watch run could not store because a probe proposal owns the model */
export interface CapabilityProposalRefreshSkip {
    readonly model: string;
    readonly reason: string;
}

export interface CapabilityProposalRefreshResult {
    /** Pending proposals after the refresh */
    readonly pending: number;
    readonly skipped: readonly CapabilityProposalRefreshSkip[];
}

/** Parse one stored payload strictly: only schema-1 JSON may be applied */
const schemaOneCapabilitiesOf = (json: string, label: string): ModelCatalogCapabilities | null => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch (error: unknown) {
        console.warn(`[catalog] ${label} 的 capabilities 不是合法 JSON，按无数据处理：`, error);
        return null;
    }
    if (!isJsonObject(parsed) || parsed.schema !== 1) return null;
    const normalized = normalizeModelCapabilities(parsed);
    if (normalized.warnings.length > 0) {
        console.warn(`[catalog] ${label} 的 capabilities 有未知值：${normalized.warnings.join('；')}`);
    }
    return normalized.capabilities;
};

/** Read whatever a row currently holds: schema-1, legacy or unparseable */
const anyCapabilitiesOf = (json: string, label = 'stored capabilities'): ModelCatalogCapabilities => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch (error: unknown) {
        console.warn(`[catalog] ${label} 的 capabilities 不是合法 JSON，按空数据处理：`, error);
        return emptyModelCapabilities();
    }
    return normalizeModelCapabilities(parsed).capabilities;
};

const proposalViewOf = (row: ModelCapabilityProposal): CapabilityProposalView => ({
    id: row.id,
    model: row.model,
    payload: schemaOneCapabilitiesOf(row.payload, `proposal ${row.id} (${row.model})`) ?? emptyModelCapabilities(),
    baseline: row.baseline === null ? null : anyCapabilitiesOf(row.baseline, `proposal ${row.id} (${row.model}) baseline`),
    detectedAt: row.detectedAt,
    status: row.status,
    runId: row.runId,
    messageId: row.messageId,
    note: row.note,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** Structural equality for the JSON-shaped capabilities values (key order irrelevant) */
const deepEqual = (first: unknown, second: unknown): boolean => {
    if (first === second) return true;
    if (Array.isArray(first) || Array.isArray(second)) {
        if (!Array.isArray(first) || !Array.isArray(second) || first.length !== second.length) return false;
        return first.every((item, index) => deepEqual(item, second[index]));
    }
    if (!isRecord(first) || !isRecord(second)) return false;
    const firstKeys = Object.keys(first);
    if (firstKeys.length !== Object.keys(second).length) return false;
    return firstKeys.every((key) => Object.hasOwn(second, key) && deepEqual(first[key], second[key]));
};

/**
 * The values a capability object asserts, without its provenance: who last
 * wrote a field is not a value change, so a baseline comparison must ignore it.
 */
const semanticCapabilitiesOf = (capabilities: ModelCatalogCapabilities): unknown => ({
    kind: capabilities.kind,
    vision: capabilities.vision,
    imageOutput: capabilities.imageOutput,
    tools: capabilities.tools,
    reasoningEffort: capabilities.reasoningEffort,
    contextTokens: capabilities.contextTokens,
    outputTokens: capabilities.outputTokens,
    modalities: capabilities.modalities ?? null,
    reasoning:
        capabilities.reasoning === undefined
            ? null
            : {
                  supported: capabilities.reasoning.supported,
                  toggle: capabilities.reasoning.toggle ?? null,
                  efforts: capabilities.reasoning.efforts ?? null,
                  defaultEffort: capabilities.reasoning.defaultEffort ?? null,
                  defaultEnabled: capabilities.reasoning.defaultEnabled ?? null,
              },
    apis: capabilities.apis ?? null,
    toolsMixing: capabilities.toolsMixing ?? null,
    nativeTools: capabilities.nativeTools ?? null,
});

/** Sources whose fields the owner maintains locally; an approval never overwrites them */
const isLocalCapabilitySource = (source: ModelCapabilitySource | undefined): boolean =>
    source === 'manual' || source === 'official';

/** The provenance of the reasoning section, the only subtree that carries its own */
const reasoningProvenanceOf = (reasoning: ModelCatalogCapabilities['reasoning']): unknown =>
    reasoning === undefined
        ? null
        : {
              source: reasoning.source ?? null,
              checkedOn: reasoning.checkedOn ?? null,
              confidence: reasoning.confidence ?? null,
          };

/**
 * Whether an approval would change anything: a value change, or a reasoning
 * provenance refresh (a probe re-check of identical values is still written).
 * Row-level provenance alone is not a change — the payload of a partly local
 * row names its upstream, which must not overwrite the row's own source.
 */
const isNoOpApproval = (merged: ModelCatalogCapabilities, current: ModelCatalogCapabilities): boolean =>
    deepEqual(semanticCapabilitiesOf(merged), semanticCapabilitiesOf(current)) &&
    deepEqual(reasoningProvenanceOf(merged.reasoning), reasoningProvenanceOf(current.reasoning));

/** The note a blank caller leaves: still says where and when the values came from */
const noteOfInput = (input: CapabilityProposalInput): string =>
    input.note.trim() === '' ? `能力变化（${input.checkedOn}）` : input.note;

/**
 * Insert a pending proposal, or refresh the pending row of the same model. The
 * pending unique index `(model) WHERE status='pending'` is why one model never
 * has two open proposals: a newer run replaces the payload, the owner keeps one
 * message per model. A create that loses that index race (the daily run and a
 * `/probe import` in the same process) refreshes the row the other call made.
 * Returns the proposal id.
 */
const upsertProposalRow = async (input: CapabilityProposalInput, runId: number | null): Promise<number> => {
    const payload = JSON.stringify(input.payload);
    const baseline = input.baseline === null ? null : JSON.stringify(input.baseline);
    const note = noteOfInput(input);
    const detectedAt = new Date();
    const existing = await ModelCapabilityProposal.findOne({
        where: { model: input.model, status: 'pending' },
    });
    if (existing !== null) {
        await existing.update({ payload, baseline, detectedAt, runId, note });
        return existing.id;
    }
    try {
        const created = await ModelCapabilityProposal.create({
            model: input.model,
            payload,
            baseline,
            detectedAt,
            status: 'pending',
            runId,
            note,
        });
        return created.id;
    } catch (error: unknown) {
        // A concurrent writer won the partial unique index; refresh its row.
        const raced = await ModelCapabilityProposal.findOne({
            where: { model: input.model, status: 'pending' },
        });
        if (raced === null) throw error;
        await raced.update({ payload, baseline, detectedAt, runId, note });
        console.warn(`[catalog] proposal insert for ${input.model} raced, refreshed the pending row`);
        return raced.id;
    }
};

/** The `/probe import` entry point (and anything else outside the watch run) */
export const upsertCapabilityProposal = async (input: CapabilityProposalInput): Promise<number> =>
    upsertProposalRow(input, null);

/**
 * Insert or refresh the proposals one watch run produced; the pending count
 * includes proposals an earlier run left open. A model whose pending proposal
 * came from `/probe import` keeps it: probe measurements outrank the models.dev
 * upstream (design §2.1), so the upstream draft waits for the owner's decision.
 */
export const createOrRefreshCapabilityProposals = async (
    drafts: readonly CapabilityProposalDraft[],
    runId: number | null
): Promise<CapabilityProposalRefreshResult> => {
    const skipped: CapabilityProposalRefreshSkip[] = [];
    for (const draft of drafts) {
        const pending = await ModelCapabilityProposal.findOne({
            where: { model: draft.model, status: 'pending' },
        });
        const pendingReasoningSource =
            pending === null
                ? undefined
                : anyCapabilitiesOf(pending.payload, `proposal ${pending.id} (${pending.model}) payload`).reasoning?.source;
        if (pendingReasoningSource === 'probe') {
            skipped.push({
                model: draft.model,
                reason: `${draft.model}：probe 提案待审批，跳过本次上游草案（probe 优先于 models.dev）`,
            });
            continue;
        }
        await upsertProposalRow(
            {
                model: draft.model,
                payload: draft.payload,
                baseline: draft.baseline,
                note: draft.note,
                checkedOn: draft.checkedOn,
            },
            runId
        );
    }
    return { pending: await countPendingCapabilityProposals(), skipped };
};

export const countPendingCapabilityProposals = async (): Promise<number> =>
    ModelCapabilityProposal.count({ where: { status: 'pending' } });

/** Newest first, pending only */
export const listPendingCapabilityProposals = async (): Promise<readonly CapabilityProposalView[]> => {
    const rows = await ModelCapabilityProposal.findAll({
        where: { status: 'pending' },
        order: [
            ['detectedAt', 'DESC'],
            ['id', 'ASC'],
        ],
    });
    return rows.map(proposalViewOf);
};

export const findCapabilityProposal = async (id: number): Promise<CapabilityProposalView | null> => {
    const row = await ModelCapabilityProposal.findByPk(id);
    return row === null ? null : proposalViewOf(row);
};

/** Remember which private message carries each proposal (edit/resend) */
export const attachCapabilityProposalMessageIds = async (
    ids: readonly number[],
    messageId: number
): Promise<void> => {
    if (ids.length === 0) return;
    await ModelCapabilityProposal.update(
        { messageId },
        { where: { id: { [Op.in]: [...ids] }, status: 'pending' } }
    );
};

/** Pending proposals older than 14 days stop being actionable */
export const expireStaleCapabilityProposals = async (now: Date): Promise<number> => {
    const cutoff = new Date(now.getTime() - PROPOSAL_TTL_MS);
    return ModelCapabilityProposal.update(
        { status: 'expired', decidedAt: now },
        { where: { status: 'pending', detectedAt: { [Op.lt]: cutoff } } }
    ).then(([affected]) => affected);
};

/** A value that exists only in the seed/manual data is kept when the payload omits it */
const mergedLocalFacts = (
    proposed: ModelCatalogCapabilities,
    current: ModelCatalogCapabilities
): ModelCatalogCapabilities => {
    const toolsMixing = current.toolsMixing ?? proposed.toolsMixing;
    const nativeTools = current.nativeTools ?? proposed.nativeTools;
    return {
        ...proposed,
        ...(toolsMixing === undefined ? {} : { toolsMixing }),
        ...(nativeTools === undefined ? {} : { nativeTools }),
    };
};

/**
 * Apply one approved payload without losing locally maintained facts (design
 * §2.4): an owner-edited or official-doc row keeps its values and only accepts
 * the approved reasoning section when that section is not local either;
 * `toolsMixing`/`nativeTools` stay as they are.
 */
const mergeApprovedCapabilities = (
    proposed: ModelCatalogCapabilities,
    current: ModelCatalogCapabilities
): ModelCatalogCapabilities => {
    const reasoning = isLocalCapabilitySource(current.reasoning?.source)
        ? current.reasoning
        : proposed.reasoning ?? current.reasoning;
    if (isLocalCapabilitySource(current.source)) {
        const keptEfforts = reasoning?.efforts ?? current.reasoningEffort;
        return {
            ...current,
            schema: 1,
            reasoningEffort: keptEfforts,
            ...(reasoning === undefined ? {} : { reasoning }),
        };
    }
    const merged = mergedLocalFacts(proposed, current);
    return {
        ...merged,
        ...(reasoning === undefined ? {} : { reasoning }),
        reasoningEffort: reasoning?.efforts ?? merged.reasoningEffort,
    };
};

/**
 * Apply the owner's approval: write `model_catalog.capabilities`, mark the
 * proposals decided and audit every row inside one transaction, then refresh
 * the in-memory registry (and its content version). Throws on a schema-less
 * payload so the transaction rolls back and the owner sees the failure.
 *
 * Guard rails (design §2.1/§2.4): a proposal whose baseline no longer matches
 * the catalog is superseded instead of overwriting newer data, and an approval
 * that merges into the current values is recorded as unchanged, not applied.
 */
export const applyCapabilityProposals = async (
    ids: readonly number[],
    actorId: number
): Promise<CapabilityApplyResult> => {
    if (ids.length === 0) {
        return { applied: 0, superseded: 0, unchanged: 0, skipped: 0, decisions: [] };
    }
    const decidedAt = new Date();
    const decisions: CapabilityApplyDecision[] = [];
    await sequelize.transaction(async (transaction) => {
        const rows = await ModelCapabilityProposal.findAll({
            where: { id: { [Op.in]: [...ids] }, status: 'pending' },
            order: [['id', 'ASC']],
            transaction,
        });
        for (const row of rows) {
            const proposed = schemaOneCapabilitiesOf(row.payload, `proposal ${row.id} (${row.model})`);
            if (proposed === null) {
                throw new Error(`capability proposal ${row.id} (${row.model}) payload is not schema-1 JSON`);
            }
            const catalogRow = await ModelCatalogEntryRow.findByPk(row.model, { transaction });
            if (catalogRow === null) {
                await row.update({ status: 'superseded', decidedAt, decidedBy: actorId }, { transaction });
                decisions.push({ id: row.id, model: row.model, outcome: 'superseded' });
                console.warn(`[catalog] capability proposal ${row.id}: ${row.model} has no catalog row, superseded`);
                continue;
            }
            const oldValue = catalogRow.capabilities;
            const current = anyCapabilitiesOf(oldValue, `catalog row ${row.model}`);
            const baseline = row.baseline === null ? null : anyCapabilitiesOf(row.baseline, `proposal ${row.id} (${row.model}) baseline`);
            // The payload was computed against the stored baseline. If the row
            // moved since, applying it would silently overwrite newer data.
            if (
                baseline !== null &&
                !deepEqual(semanticCapabilitiesOf(current), semanticCapabilitiesOf(baseline))
            ) {
                await row.update({ status: 'superseded', decidedAt, decidedBy: actorId }, { transaction });
                decisions.push({ id: row.id, model: row.model, outcome: 'superseded' });
                console.warn(
                    `[catalog] capability proposal ${row.id} (${row.model}): catalog drifted since the proposal, superseded`
                );
                continue;
            }
            const merged = mergeApprovedCapabilities(proposed, current);
            if (isNoOpApproval(merged, current)) {
                await row.update({ status: 'approved', decidedAt, decidedBy: actorId }, { transaction });
                decisions.push({ id: row.id, model: row.model, outcome: 'unchanged' });
                continue;
            }
            const newValue = JSON.stringify(merged);
            await catalogRow.update({ capabilities: newValue }, { transaction });
            await row.update({ status: 'approved', decidedAt, decidedBy: actorId }, { transaction });
            await writeSettingsAudit(
                {
                    actorId,
                    scope: 'model-catalog',
                    key: `${row.model}:capabilities`,
                    oldValue,
                    newValue,
                },
                { transaction }
            );
            decisions.push({ id: row.id, model: row.model, outcome: 'applied' });
        }
    });
    const applied = decisions.filter((decision) => decision.outcome === 'applied').length;
    const superseded = decisions.filter((decision) => decision.outcome === 'superseded').length;
    const unchanged = decisions.filter((decision) => decision.outcome === 'unchanged').length;
    if (applied > 0) await loadModelCatalog();
    return { applied, superseded, unchanged, skipped: ids.length - decisions.length, decisions };
};

/** Reject without writing the catalog; kept for the audit trail */
export const rejectCapabilityProposals = async (ids: readonly number[], actorId: number): Promise<number> => {
    if (ids.length === 0) return 0;
    const decidedAt = new Date();
    let rejected = 0;
    await sequelize.transaction(async (transaction) => {
        const rows = await ModelCapabilityProposal.findAll({
            where: { id: { [Op.in]: [...ids] }, status: 'pending' },
            transaction,
        });
        for (const row of rows) {
            // The audit trail shows the row's actual value, not the rejected payload
            const catalogRow = await ModelCatalogEntryRow.findByPk(row.model, { transaction });
            await row.update({ status: 'rejected', decidedAt, decidedBy: actorId }, { transaction });
            await writeSettingsAudit(
                {
                    actorId,
                    scope: 'model-catalog',
                    key: `${row.model}:capabilities`,
                    oldValue: catalogRow?.capabilities ?? row.baseline,
                    newValue: 'rejected',
                },
                { transaction }
            );
            rejected += 1;
        }
    });
    return rejected;
};

// ---------------------------------------------------------------------------
// Approval message rendering: field-level old → new from payload vs baseline
// ---------------------------------------------------------------------------

const KIND_LABELS: Readonly<Record<string, string>> = { chat: '文本', image: '图像' };

const booleanTextOf = (value: boolean | undefined): string =>
    value === undefined ? '未知' : value ? '是' : '否';

const enabledTextOf = (value: boolean | null | undefined): string =>
    value === undefined || value === null ? '未知' : value ? '开' : '关';

const tokenTextOf = (value: number | null | undefined): string =>
    value === undefined || value === null ? '未知' : String(value);

const effortListTextOf = (values: readonly string[] | undefined): string =>
    values === undefined ? '未知' : values.length === 0 ? '无' : values.join('/');

const modalityListTextOf = (values: readonly string[] | undefined): string =>
    values === undefined ? '未知' : values.length === 0 ? '无' : values.join('/');

const apiFlagTextOf = (value: boolean | undefined): string => booleanTextOf(value);

const modalityOf = (modalities: ModelCatalogModalities | undefined, key: 'input' | 'output'): string =>
    modalityListTextOf(modalities?.[key]);

const defaultEffortTextOf = (value: string | null | undefined): string =>
    value === undefined || value === null ? '未知' : value;

/**
 * Every semantic capability field that differs between the approved payload and
 * the row's current values, with Chinese labels for the owner message. Only for
 * display: the source/provenance fields are not compared.
 */
export const capabilityFieldChangesOf = (
    payload: ModelCatalogCapabilities,
    baseline: ModelCatalogCapabilities | null
): readonly CapabilityFieldChangeView[] => {
    const changes: CapabilityFieldChangeView[] = [];
    const compare = (field: string, label: string, oldValue: string, newValue: string): void => {
        if (oldValue !== newValue) changes.push({ field, label, oldValue, newValue });
    };
    const oldKind = baseline === null ? '未知' : KIND_LABELS[baseline.kind] ?? baseline.kind;
    compare('kind', '类型', oldKind, KIND_LABELS[payload.kind] ?? payload.kind);
    compare('vision', '图片输入', booleanTextOf(baseline?.vision), booleanTextOf(payload.vision));
    compare('imageOutput', '图片输出', booleanTextOf(baseline?.imageOutput), booleanTextOf(payload.imageOutput));
    compare('tools', '工具调用', booleanTextOf(baseline?.tools), booleanTextOf(payload.tools));
    compare('contextTokens', '上下文上限', tokenTextOf(baseline?.contextTokens), tokenTextOf(payload.contextTokens));
    compare('outputTokens', '输出上限', tokenTextOf(baseline?.outputTokens), tokenTextOf(payload.outputTokens));
    compare('modalities.input', '输入模态', modalityOf(baseline?.modalities, 'input'), modalityOf(payload.modalities, 'input'));
    compare('modalities.output', '输出模态', modalityOf(baseline?.modalities, 'output'), modalityOf(payload.modalities, 'output'));
    compare(
        'reasoning.supported',
        '思考能力',
        booleanTextOf(baseline?.reasoning?.supported),
        booleanTextOf(payload.reasoning?.supported)
    );
    compare(
        'reasoning.toggle',
        '思考开关',
        booleanTextOf(baseline?.reasoning?.toggle),
        booleanTextOf(payload.reasoning?.toggle)
    );
    compare(
        'reasoning.efforts',
        '思考档位',
        effortListTextOf(baseline?.reasoning?.efforts),
        effortListTextOf(payload.reasoning?.efforts)
    );
    compare(
        'reasoning.defaultEffort',
        '默认档位',
        defaultEffortTextOf(baseline?.reasoning?.defaultEffort),
        defaultEffortTextOf(payload.reasoning?.defaultEffort)
    );
    compare(
        'reasoning.defaultEnabled',
        '默认思考',
        enabledTextOf(baseline?.reasoning?.defaultEnabled),
        enabledTextOf(payload.reasoning?.defaultEnabled)
    );
    const apiFlags = ['reasoning', 'tools', 'structuredOutput'] as const;
    const apiFlagLabels: Readonly<Record<(typeof apiFlags)[number], string>> = {
        reasoning: '思考',
        tools: '工具',
        structuredOutput: '结构化输出',
    };
    for (const apiName of MODEL_APIS) {
        for (const flag of apiFlags) {
            compare(
                `apis.${apiName}.${flag}`,
                `API ${apiName}·${apiFlagLabels[flag]}`,
                apiFlagTextOf(baseline?.apis?.[apiName]?.[flag]),
                apiFlagTextOf(payload.apis?.[apiName]?.[flag])
            );
        }
    }
    return changes;
};

/** The source names the approval message prints */
export const capabilitySourceLabelOf = (source: ModelCapabilitySource | undefined): string => {
    if (source === 'code') return '代码 seed';
    if (source === 'probe') return 'probe';
    if (source === 'manual') return '人工';
    if (source === 'official') return '官方文档';
    return 'models.dev';
};
