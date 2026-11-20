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
    deriveFieldProvenance,
    emptyModelCapabilities,
    fieldProvenanceOf,
    hasProvenanceSource,
    MODEL_APIS,
    normalizeModelCapabilities,
    type CapabilityFieldProvenance,
    type CapabilityProvenanceMap,
    type ModelCatalogCapabilities,
    type ModelCatalogModalities,
    type ModelCapabilitySource,
    type PlatformLaneFingerprints,
} from '../config/model-capabilities.js';
import { isJsonObject } from '../shared/json-object.js';
import { loadModelCatalog } from './model-catalog-service.js';
import type { CapabilityProposalDraft } from './capability-catalog-types.js';

/** Pending proposals older than this stop being actionable */
const PROPOSAL_TTL_MS = 14 * 24 * 3600 * 1000;
/** Unchanged pending proposals are reminded at most once per this interval */
const REMINDER_INTERVAL_MS = 3 * 24 * 3600 * 1000;

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
    readonly lastNotifiedAt: Date | null;
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
    lastNotifiedAt: row.lastNotifiedAt,
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
 * Whether an approval would change anything: a value change, a reasoning
 * provenance refresh, or field-level provenance / lane fingerprint updates
 * (a probe v2 re-check of identical values still persists its lane and date).
 */
const isNoOpApproval = (merged: ModelCatalogCapabilities, current: ModelCatalogCapabilities): boolean =>
    deepEqual(semanticCapabilitiesOf(merged), semanticCapabilitiesOf(current)) &&
    deepEqual(reasoningProvenanceOf(merged.reasoning), reasoningProvenanceOf(current.reasoning)) &&
    deepEqual(merged.provenance ?? null, current.provenance ?? null) &&
    deepEqual(merged.laneFingerprints ?? null, current.laneFingerprints ?? null);

/** The note a blank caller leaves: still says where and when the values came from */
const noteOfInput = (input: CapabilityProposalInput): string =>
    input.note.trim() === '' ? `能力变化（${input.checkedOn}）` : input.note;

const noteWithoutCheckDate = (note: string): string =>
    note.replace(/（(models\.dev|traffic)，\d{4}-\d{2}-\d{2}）$/, '（$1）');

const provenanceSourcesOf = (capabilities: ModelCatalogCapabilities): Readonly<Record<string, string>> => {
    if (capabilities.provenance !== undefined) {
        const result: Record<string, string> = {};
        for (const [key, entry] of Object.entries(capabilities.provenance)) {
            if (entry !== undefined) result[key] = entry.source;
        }
        return result;
    }
    return {
        row: capabilities.source ?? '',
        reasoning: capabilities.reasoning?.source ?? '',
    };
};

/**
 * Whether an existing pending proposal already carries the same proposed change.
 * For watch runs (`runId !== null`), advancing `checkedOn` alone keeps the
 * existing row untouched so `detectedAt` (14-day TTL) and `lastNotifiedAt`
 * (3-day reminder) stay accurate.
 */
const isCapabilityProposalUnchanged = (
    existing: ModelCapabilityProposal,
    payloadJson: string,
    baselineJson: string | null,
    note: string,
    input: CapabilityProposalInput,
    runId: number | null
): boolean => {
    if (existing.payload === payloadJson && existing.baseline === baselineJson && existing.note === note) {
        return true;
    }
    if (runId === null) return false;
    if (noteWithoutCheckDate(existing.note ?? '') !== noteWithoutCheckDate(note)) return false;
    const existingPayload = schemaOneCapabilitiesOf(existing.payload, `proposal ${existing.id} (${existing.model})`);
    if (existingPayload === null) return false;
    if (!deepEqual(semanticCapabilitiesOf(input.payload), semanticCapabilitiesOf(existingPayload))) return false;
    if (
        input.payload.source !== existingPayload.source ||
        input.payload.reasoning?.source !== existingPayload.reasoning?.source ||
        !deepEqual(provenanceSourcesOf(input.payload), provenanceSourcesOf(existingPayload))
    ) {
        return false;
    }
    if (existing.baseline === null && input.baseline === null) return true;
    if (existing.baseline === null || input.baseline === null) return false;
    const existingBaseline = anyCapabilitiesOf(existing.baseline, `proposal ${existing.id} (${existing.model}) baseline`);
    return deepEqual(semanticCapabilitiesOf(input.baseline), semanticCapabilitiesOf(existingBaseline));
};

/**
 * Insert a pending proposal, or refresh the pending row of the same model. The
 * pending unique index `(model) WHERE status='pending'` is why one model never
 * has two open proposals: a newer run replaces the payload, the owner keeps one
 * message per model. Preserves `detectedAt` and `lastNotifiedAt` when unchanged.
 */
const upsertProposalRow = async (
    input: CapabilityProposalInput,
    runId: number | null,
    now: Date = new Date()
): Promise<number> => {
    const payload = JSON.stringify(input.payload);
    const baseline = input.baseline === null ? null : JSON.stringify(input.baseline);
    const note = noteOfInput(input);
    const existing = await ModelCapabilityProposal.findOne({
        where: { model: input.model, status: 'pending' },
    });
    if (existing !== null) {
        if (isCapabilityProposalUnchanged(existing, payload, baseline, note, input, runId)) {
            return existing.id;
        }
        await existing.update({ payload, baseline, detectedAt: now, lastNotifiedAt: null, runId, note });
        return existing.id;
    }
    try {
        const created = await ModelCapabilityProposal.create({
            model: input.model,
            payload,
            baseline,
            detectedAt: now,
            status: 'pending',
            runId,
            lastNotifiedAt: null,
            note,
        });
        return created.id;
    } catch (error: unknown) {
        // A concurrent writer won the partial unique index; refresh its row.
        const raced = await ModelCapabilityProposal.findOne({
            where: { model: input.model, status: 'pending' },
        });
        if (raced === null) throw error;
        if (!isCapabilityProposalUnchanged(raced, payload, baseline, note, input, runId)) {
            await raced.update({ payload, baseline, detectedAt: now, lastNotifiedAt: null, runId, note });
        }
        console.warn(`[catalog] proposal insert for ${input.model} raced, refreshed the pending row`);
        return raced.id;
    }
};

/** The `/probe import` entry point (and anything else outside the watch run) */
export const upsertCapabilityProposal = async (input: CapabilityProposalInput): Promise<number> =>
    upsertProposalRow(input, null);

export interface RefreshCapabilityProposalsOptions {
    /** Models whose upstream documents compiled cleanly; pending watch rows not re-drafted are withdrawn */
    readonly evaluatedModels?: ReadonlySet<string>;
    readonly now?: Date;
}

/** Whether a pending capability proposal has never been sent or is due for a 3-day reminder */
export const isCapabilityProposalDueForNotification = (
    proposal: Pick<CapabilityProposalView, 'lastNotifiedAt'>,
    now: Date = new Date()
): boolean =>
    proposal.lastNotifiedAt === null || now.getTime() - proposal.lastNotifiedAt.getTime() >= REMINDER_INTERVAL_MS;

/**
 * Insert or refresh the proposals one watch run produced; the pending count
 * includes proposals an earlier run left open. A model whose pending proposal
 * came from `/probe import` keeps it: probe measurements outrank the models.dev
 * upstream (design §2.1), so the upstream draft waits for the owner's decision
 * and is never withdrawn by the upstream watcher.
 */
export const createOrRefreshCapabilityProposals = async (
    drafts: readonly CapabilityProposalDraft[],
    runId: number | null,
    options: RefreshCapabilityProposalsOptions = {}
): Promise<CapabilityProposalRefreshResult> => {
    const now = options.now ?? new Date();
    const skipped: CapabilityProposalRefreshSkip[] = [];
    const handledModels = new Set<string>();
    for (const draft of drafts) {
        handledModels.add(draft.model);
        const pending = await ModelCapabilityProposal.findOne({
            where: { model: draft.model, status: 'pending' },
        });
        const pendingCapabilities =
            pending === null
                ? null
                : anyCapabilitiesOf(pending.payload, `proposal ${pending.id} (${pending.model}) payload`);
        const pendingHasProbe = pendingCapabilities !== null && hasProvenanceSource(pendingCapabilities, 'probe');
        const draftHasTraffic = hasProvenanceSource(draft.payload, 'traffic');
        if (pendingHasProbe && !draftHasTraffic) {
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
            runId,
            now
        );
    }
    if (options.evaluatedModels !== undefined && options.evaluatedModels.size > 0) {
        const pendingForEvaluated = await ModelCapabilityProposal.findAll({
            where: {
                status: 'pending',
                model: { [Op.in]: [...options.evaluatedModels] },
            },
        });
        for (const row of pendingForEvaluated) {
            if (handledModels.has(row.model)) continue;
            const pendingPayload = anyCapabilitiesOf(
                row.payload,
                `proposal ${row.id} (${row.model}) payload`
            );
            // Probe and live-traffic proposals are never invalidated just because
            // upstream models.dev produced no diff for the model.
            if (hasProvenanceSource(pendingPayload, 'probe') || hasProvenanceSource(pendingPayload, 'traffic')) {
                continue;
            }
            await row.update({ status: 'withdrawn', decidedAt: now });
        }
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

/** Pending capability proposals carried by one approval message */
export const listPendingCapabilityProposalsByMessageId = async (
    messageId: number
): Promise<readonly CapabilityProposalView[]> => {
    const rows = await ModelCapabilityProposal.findAll({
        where: { status: 'pending', messageId },
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

/** Remember which private message carries each proposal and when it was sent */
export const attachCapabilityProposalMessageIds = async (
    ids: readonly number[],
    messageId: number,
    notifiedAt: Date = new Date()
): Promise<void> => {
    if (ids.length === 0) return;
    await ModelCapabilityProposal.update(
        { messageId, lastNotifiedAt: notifiedAt },
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

const mergedFieldProvenance = (
    proposed: ModelCatalogCapabilities,
    current: ModelCatalogCapabilities
): CapabilityProvenanceMap | undefined => {
    if (proposed.provenance === undefined && current.provenance === undefined) return undefined;
    const base = current.provenance ?? deriveFieldProvenance(current);
    const incoming = proposed.provenance ?? {};
    const merged: Record<string, CapabilityFieldProvenance | undefined> = { ...base };
    for (const [field, entry] of Object.entries(incoming)) {
        if (entry === undefined) continue;
        const currentEntry = base[field];
        if (isLocalCapabilitySource(currentEntry?.source) && !isLocalCapabilitySource(entry.source)) {
            continue;
        }
        merged[field] = entry;
    }
    return merged;
};

const mergedLaneFingerprints = (
    proposed: ModelCatalogCapabilities,
    current: ModelCatalogCapabilities
): PlatformLaneFingerprints | undefined => {
    if (proposed.laneFingerprints === undefined && current.laneFingerprints === undefined) return undefined;
    return {
        ...current.laneFingerprints,
        ...proposed.laneFingerprints,
    };
};

/**
 * Apply one approved payload without losing locally maintained facts (design
 * §2.4 / §3.2): manual/official rows and fields stay protected unless the
 * proposal itself targets non-local fields or uses field-level provenance;
 * `toolsMixing`/`nativeTools` stay intact unless explicitly updated (e.g. traffic).
 */
const mergeApprovedCapabilities = (
    proposed: ModelCatalogCapabilities,
    current: ModelCatalogCapabilities
): ModelCatalogCapabilities => {
    const provenance = mergedFieldProvenance(proposed, current);
    const laneFingerprints = mergedLaneFingerprints(proposed, current);
    const isReasoningProtected =
        current.provenance === undefined
            ? isLocalCapabilitySource(current.reasoning?.source)
            : isLocalCapabilitySource(fieldProvenanceOf(current, 'reasoning.efforts')?.source) &&
              !hasProvenanceSource(proposed, 'traffic');
    const reasoning = isReasoningProtected ? current.reasoning : (proposed.reasoning ?? current.reasoning);
    if (isLocalCapabilitySource(current.source) && current.provenance === undefined) {
        const keptEfforts = reasoning?.efforts ?? current.reasoningEffort;
        return {
            ...current,
            schema: 1,
            reasoningEffort: keptEfforts,
            ...(reasoning === undefined ? {} : { reasoning }),
            ...(provenance === undefined ? {} : { provenance }),
            ...(laneFingerprints === undefined ? {} : { laneFingerprints }),
        };
    }
    const merged = mergedLocalFacts(proposed, current);
    const toolsMixing =
        proposed.provenance?.['toolsMixing']?.source === 'traffic'
            ? (proposed.toolsMixing ?? current.toolsMixing)
            : (current.toolsMixing ?? proposed.toolsMixing);
    return {
        ...merged,
        ...(toolsMixing === undefined ? {} : { toolsMixing }),
        ...(reasoning === undefined ? {} : { reasoning }),
        reasoningEffort: reasoning?.efforts ?? merged.reasoningEffort,
        ...(provenance === undefined ? {} : { provenance }),
        ...(laneFingerprints === undefined ? {} : { laneFingerprints }),
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
        compare(
            `apis.${apiName}`,
            `API ${apiName}`,
            booleanTextOf(baseline?.apis === undefined ? undefined : baseline.apis[apiName] !== undefined),
            booleanTextOf(payload.apis === undefined ? undefined : payload.apis[apiName] !== undefined)
        );
        for (const flag of apiFlags) {
            compare(
                `apis.${apiName}.${flag}`,
                `API ${apiName}·${apiFlagLabels[flag]}`,
                apiFlagTextOf(baseline?.apis?.[apiName]?.[flag]),
                apiFlagTextOf(payload.apis?.[apiName]?.[flag])
            );
        }
    }
    compare(
        'toolsMixing',
        '工具混用',
        baseline?.toolsMixing ?? '未知',
        payload.toolsMixing ?? '未知'
    );
    return changes;
};

/** The source names the approval message prints */
export const capabilitySourceLabelOf = (source: ModelCapabilitySource | undefined): string => {
    if (source === 'code') return '代码 seed';
    if (source === 'probe') return 'probe';
    if (source === 'manual') return '人工';
    if (source === 'official') return '官方文档';
    if (source === 'traffic') return '线上流量';
    return 'models.dev';
};
