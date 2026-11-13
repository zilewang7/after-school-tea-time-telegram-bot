/**
 * Price table storage and lifecycle (pricing design 2026-1113-1150).
 *
 * The table lives in SQLite (`model_price_entries`), rows are append-only and
 * carry exclusive UTC windows. This service is the only writer: it seeds a
 * fresh database from the built-in rows, loads the registry `src/config/
 * model-pricing.ts` reads, records watcher proposals and applies the ones the
 * owner approves. Every write is audited in settings_audit with scope
 * 'pricing' (one row per model·tier), so the panel's audit page shows who
 * changed what and when.
 *
 * Nothing here talks to the network: the watcher passes in proposals and the
 * approval command passes in ids.
 */
import { Op, QueryTypes, type Transaction } from '@sequelize/core';
import { sequelize } from '../db/config.js';
import { ModelPriceEntry, isPriceConfidence, isPriceSource } from '../db/modelPriceDTO.js';
import { PriceChangeProposal } from '../db/priceChangeProposalDTO.js';
import { PriceWatchRun } from '../db/priceWatchRunDTO.js';
import { writeSettingsAudit } from '../db/queries/settings-audit.js';
import { isJsonObject } from '../shared/json-object.js';
import {
    allPriceEntries,
    findPriceAt,
    priceTableVersion,
    seedPriceEntries,
    setPriceEntries,
    type PriceEntry,
    type PriceConfidence,
    type PriceSource,
    type PriceTier,
} from '../config/model-pricing.js';
import type { ProposalDraft } from './price-catalog-types.js';

/** A proposal as the approval UI sees it (payload already parsed) */
export interface PriceProposalView {
    readonly id: number;
    readonly kind: 'update' | 'new_model' | 'expiry';
    readonly model: string;
    readonly tier: PriceTier;
    readonly effectiveFrom: Date;
    readonly effectiveTo: Date | null;
    readonly payload: PriceEntry;
    readonly baseline: PriceEntry | null;
    readonly detectedAt: Date;
    readonly status: string;
    readonly runId: number | null;
    readonly messageId: number | null;
    readonly note: string | null;
}

/** One price origin the panel shows, with the newest date it was checked */
export interface PriceSourceMeta {
    readonly kind: PriceSource;
    readonly checkedOn: string;
}

/** A price window that starts (or ends) within the next days */
export interface NextPriceChange {
    readonly model: string;
    readonly tier: PriceTier;
    /** ISO instant of the change */
    readonly at: string;
    /** One line, e.g. `标准价 2.00/0.10/10.00 → 4.00/0.20/20.00` */
    readonly summary: string;
}

/** Metadata the panel and the approval message read */
export interface PriceTableMeta {
    readonly version: string;
    /** The oldest checkedOn in the table; null for an empty table */
    readonly checkedOn: string | null;
    readonly sources: readonly PriceSourceMeta[];
    readonly nextChanges: readonly NextPriceChange[];
    /** Models seen in the last 30 days of replies that still have no row */
    readonly unpricedModels: readonly string[];
    readonly pendingProposals: number;
}

/** Process status of the watcher, for /api/status and `/pricing status` */
export interface PriceWatchStatus {
    readonly version: string;
    readonly lastRunAt: string | null;
    readonly lastOutcome: string | null;
    readonly lastError: string | null;
    readonly pendingProposals: number;
}

export interface ApplyProposalsResult {
    readonly applied: number;
    readonly skipped: number;
}

const OPEN_END = Number.POSITIVE_INFINITY;

const isoOrNull = (date: Date | null | undefined): string | null =>
    date === undefined || date === null ? null : date.toISOString();

/** Narrow a stored source/confidence string; unknown values degrade, never guess */
const readSource = (value: string): PriceSource => (isPriceSource(value) ? value : 'manual');
const readConfidence = (value: string): PriceConfidence =>
    isPriceConfidence(value) ? value : 'low';

const entryOfRow = (row: ModelPriceEntry): PriceEntry => ({
    model: row.model,
    tier: row.tier === 'priority' ? 'priority' : 'standard',
    inputPerM: row.inputPerM,
    cachedInputPerM: row.cachedInputPerM,
    outputPerM: row.outputPerM,
    ...(row.cacheWritePerM === null ? {} : { cacheWritePerM: row.cacheWritePerM }),
    ...(row.imageOutputPerM === null ? {} : { imageOutputPerM: row.imageOutputPerM }),
    ...(row.perImageUsd === null ? {} : { perImageUsd: row.perImageUsd }),
    effectiveFrom: row.effectiveFrom,
    ...(row.effectiveTo === null ? {} : { effectiveTo: row.effectiveTo }),
    source: isPriceSource(row.source) ? row.source : 'manual',
    ...(row.sourceUrl === null ? {} : { sourceUrl: row.sourceUrl }),
    checkedOn: row.checkedOn,
    confidence: isPriceConfidence(row.confidence) ? row.confidence : 'low',
    ...(row.note === null ? {} : { note: row.note }),
});

/** The values a row stores for one entry, in the DTO's shape */
interface NewPriceRow {
    readonly model: string;
    readonly tier: string;
    readonly inputPerM: number;
    readonly cachedInputPerM: number;
    readonly cacheWritePerM: number | null;
    readonly outputPerM: number;
    readonly imageOutputPerM: number | null;
    readonly perImageUsd: number | null;
    readonly effectiveFrom: Date;
    readonly effectiveTo: Date | null;
    readonly source: string;
    readonly sourceUrl: string | null;
    readonly checkedOn: string;
    readonly confidence: string;
    readonly note: string | null;
}

const rowValuesOf = (entry: PriceEntry): NewPriceRow => ({
    model: entry.model,
    tier: entry.tier,
    inputPerM: entry.inputPerM,
    cachedInputPerM: entry.cachedInputPerM,
    cacheWritePerM: entry.cacheWritePerM ?? null,
    outputPerM: entry.outputPerM,
    imageOutputPerM: entry.imageOutputPerM ?? null,
    perImageUsd: entry.perImageUsd ?? null,
    effectiveFrom: entry.effectiveFrom,
    effectiveTo: entry.effectiveTo ?? null,
    source: entry.source,
    sourceUrl: entry.sourceUrl ?? null,
    checkedOn: entry.checkedOn,
    confidence: entry.confidence,
    note: entry.note ?? null,
});

const serializeEntry = (entry: PriceEntry): string =>
    JSON.stringify({
        ...entry,
        effectiveFrom: entry.effectiveFrom.toISOString(),
        effectiveTo: isoOrNull(entry.effectiveTo),
    });

const deserializeEntry = (json: string): PriceEntry => {
    const raw: unknown = JSON.parse(json);
    if (!isJsonObject(raw)) throw new Error('a price entry must be an object');
    const record = raw;
    const number = (key: string): number => {
        const value = record[key];
        if (typeof value !== 'number') throw new Error(`price entry.${key} must be a number`);
        return value;
    };
    const text = (key: string): string => {
        const value = record[key];
        if (typeof value !== 'string') throw new Error(`price entry.${key} must be a string`);
        return value;
    };
    const optionalNumber = (key: string): number | undefined => {
        const value = record[key];
        return typeof value === 'number' ? value : undefined;
    };
    const optionalText = (key: string): string | undefined => {
        const value = record[key];
        return typeof value === 'string' ? value : undefined;
    };
    const from = new Date(text('effectiveFrom'));
    const to = optionalText('effectiveTo');
    return {
        model: text('model'),
        tier: text('tier') === 'priority' ? 'priority' : 'standard',
        inputPerM: number('inputPerM'),
        cachedInputPerM: number('cachedInputPerM'),
        outputPerM: number('outputPerM'),
        ...(optionalNumber('cacheWritePerM') === undefined
            ? {}
            : { cacheWritePerM: optionalNumber('cacheWritePerM') }),
        ...(optionalNumber('imageOutputPerM') === undefined
            ? {}
            : { imageOutputPerM: optionalNumber('imageOutputPerM') }),
        ...(optionalNumber('perImageUsd') === undefined ? {} : { perImageUsd: optionalNumber('perImageUsd') }),
        effectiveFrom: from,
        ...(to === undefined ? {} : { effectiveTo: new Date(to) }),
        source: readSource(text('source')),
        ...(optionalText('sourceUrl') === undefined ? {} : { sourceUrl: optionalText('sourceUrl') }),
        checkedOn: text('checkedOn'),
        confidence: readConfidence(text('confidence')),
        ...(optionalText('note') === undefined ? {} : { note: optionalText('note') }),
    };
};

const proposalViewOf = (row: PriceChangeProposal): PriceProposalView => ({
    id: row.id,
    kind: row.kind === 'new_model' ? 'new_model' : row.kind === 'expiry' ? 'expiry' : 'update',
    model: row.model,
    tier: row.tier === 'priority' ? 'priority' : 'standard',
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    payload: deserializeEntry(row.payload),
    baseline: row.baseline === null ? null : deserializeEntry(row.baseline),
    detectedAt: row.detectedAt,
    status: row.status,
    runId: row.runId,
    messageId: row.messageId,
    note: row.note,
});

/** pYYYYMMDD-<rows>: stable enough to show, changes whenever the table does */
const versionOf = (rows: readonly ModelPriceEntry[]): string => {
    if (rows.length === 0) return 'seed';
    const newest = rows.reduce(
        (latest, row) => (row.updatedAt.getTime() > latest.getTime() ? row.updatedAt : latest),
        rows[0]!.updatedAt
    );
    const stamp = newest.toISOString().slice(0, 10).replace(/-/g, '');
    return `p${stamp}-${rows.length}`;
};

let loadedSources: readonly PriceSourceMeta[] = [];

const sourcesOf = (entries: readonly PriceEntry[]): readonly PriceSourceMeta[] => {
    const newest = new Map<PriceSource, string>();
    for (const entry of entries) {
        const current = newest.get(entry.source);
        if (current === undefined || entry.checkedOn > current) newest.set(entry.source, entry.checkedOn);
    }
    return [...newest.entries()]
        .map(([kind, checkedOn]) => ({ kind, checkedOn }))
        .sort((first, second) => first.kind.localeCompare(second.kind));
};

const readRows = async (): Promise<ModelPriceEntry[]> =>
    ModelPriceEntry.findAll({
        order: [
            ['model', 'ASC'],
            ['tier', 'ASC'],
            ['effectiveFrom', 'ASC'],
        ],
    });

const seedIfEmpty = async (): Promise<void> => {
    const count = await ModelPriceEntry.count();
    if (count > 0) return;
    const rows = seedPriceEntries().map((entry) => rowValuesOf(entry));
    await ModelPriceEntry.bulkCreate(rows);
    console.log(`[pricing] seeded ${rows.length} rows into model_price_entries`);
};

/**
 * Load the table into the in-memory registry. Never throws: on a failure the
 * registry keeps the built-in seed, which is exactly the pre-feature behavior.
 */
export const loadModelPrices = async (): Promise<void> => {
    try {
        await seedIfEmpty();
        const rows = await readRows();
        const entries = rows.map(entryOfRow);
        setPriceEntries(entries, versionOf(rows));
        loadedSources = sourcesOf(entries);
        console.log(`[pricing] loaded ${entries.length} rows (${priceTableVersion()})`);
    } catch (error: unknown) {
        console.error('[pricing] loading the price table failed, using the built-in rows:', error);
    }
};

/** Every row in force, oldest window first (the watcher diffs against it) */
export const currentPriceRows = async (): Promise<readonly PriceEntry[]> => (await readRows()).map(entryOfRow);

const formatPrice = (price: { inputPerM: number; cachedInputPerM: number; outputPerM: number }): string =>
    `${price.inputPerM}/${price.cachedInputPerM}/${price.outputPerM}`;

const tierLabel = (tier: PriceTier): string => (tier === 'priority' ? 'priority' : '标准价');

/** Windows starting (or ending) within `days`, with the change in one line */
export const nextPriceChangesOf = (now: Date, days = 30): readonly NextPriceChange[] => {
    const until = new Date(now.getTime() + days * 24 * 3600 * 1000);
    return allCurrentEntries()
        .flatMap((entry) => {
            const from = entry.effectiveFrom.getTime();
            if (from <= now.getTime() || from > until.getTime()) return [];
            const previous = findPriceAt(entry.model, new Date(from - 1));
            const before = previous === null ? '未定价' : formatPrice(previous);
            return [
                {
                    model: entry.model,
                    tier: entry.tier,
                    at: entry.effectiveFrom.toISOString(),
                    summary: `${tierLabel(entry.tier)} ${before} → ${formatPrice(entry)}`,
                },
            ];
        })
        .sort((first, second) => first.at.localeCompare(second.at));
};

/** Every row of the registry (the watcher's diff and the panel meta use it) */
export const allCurrentEntries = (): readonly PriceEntry[] => allPriceEntries();

export const countPendingProposals = async (): Promise<number> =>
    PriceChangeProposal.count({ where: { status: 'pending' } });

const unpricedModelsSince = async (since: Date): Promise<readonly string[]> => {
    const rows: unknown[] = await sequelize.query(
        'SELECT DISTINCT model FROM reply_metrics WHERE startedAt >= :since',
        { replacements: { since }, type: QueryTypes.SELECT }
    );
    const seen = rows.flatMap((row) => {
        const model = isJsonObject(row) ? row.model : undefined;
        return typeof model === 'string' ? [model] : [];
    });
    const now = new Date();
    return seen
        .filter((model) => findPriceAt(model, now) === null)
        .sort((first, second) => first.localeCompare(second));
};

/** Everything the panel's pricing block shows (one DB round trip for unpriced) */
export const loadPriceTableMeta = async (now: Date): Promise<PriceTableMeta> => {
    const entries = allCurrentEntries();
    const checkedOn =
        entries.length === 0
            ? null
            : entries.reduce(
                  (oldest, entry) => (entry.checkedOn < oldest ? entry.checkedOn : oldest),
                  entries[0]!.checkedOn
              );
    const [unpricedModels, pendingProposals] = await Promise.all([
        unpricedModelsSince(new Date(now.getTime() - 30 * 24 * 3600 * 1000)),
        countPendingProposals(),
    ]);
    return {
        version: priceTableVersion(),
        checkedOn,
        sources: loadedSources.length === 0 ? sourcesOf(entries) : loadedSources,
        nextChanges: nextPriceChangesOf(now),
        unpricedModels,
        pendingProposals,
    };
};

/** The owner-facing status line (`/pricing status`, /api/status) */
export const priceWatchStatus = async (): Promise<PriceWatchStatus> => {
    const [lastRun, pendingProposals] = await Promise.all([
        PriceWatchRun.findOne({ order: [['startedAt', 'DESC']] }),
        countPendingProposals(),
    ]);
    return {
        version: priceTableVersion(),
        lastRunAt: lastRun === null ? null : lastRun.startedAt.toISOString(),
        lastOutcome: lastRun === null ? null : lastRun.outcome,
        lastError: lastRun?.error ?? null,
        pendingProposals,
    };
};

/** Insert or refresh the proposals one watch run produced; returns the pending count */
export const createOrRefreshProposals = async (
    drafts: readonly ProposalDraft[],
    runId: number | null
): Promise<number> => {
    const detectedAt = new Date();
    for (const draft of drafts) {
        const payload = serializeEntry(draft.entry);
        const baseline = draft.baseline === null ? null : serializeEntry(draft.baseline);
        const existing = await PriceChangeProposal.findOne({
            where: {
                kind: draft.kind,
                model: draft.model,
                tier: draft.tier,
                effectiveFrom: draft.entry.effectiveFrom,
                status: 'pending',
            },
        });
        if (existing === null) {
            await PriceChangeProposal.create({
                kind: draft.kind,
                model: draft.model,
                tier: draft.tier,
                effectiveFrom: draft.entry.effectiveFrom,
                effectiveTo: draft.entry.effectiveTo ?? null,
                payload,
                baseline,
                detectedAt,
                status: 'pending',
                runId,
                note: draft.note,
            });
        } else {
            await existing.update({ payload, baseline, detectedAt, runId, note: draft.note });
        }
    }
    return countPendingProposals();
};

/** Newest first, pending only */
export const listPendingProposals = async (): Promise<readonly PriceProposalView[]> => {
    const rows = await PriceChangeProposal.findAll({
        where: { status: 'pending' },
        order: [
            ['detectedAt', 'DESC'],
            ['id', 'ASC'],
        ],
    });
    return rows.map(proposalViewOf);
};

export const findProposal = async (id: number): Promise<PriceProposalView | null> => {
    const row = await PriceChangeProposal.findByPk(id);
    return row === null ? null : proposalViewOf(row);
};

/** Remember which private message carries each proposal (edit/resend) */
export const attachProposalMessageIds = async (ids: readonly number[], messageId: number): Promise<void> => {
    if (ids.length === 0) return;
    await PriceChangeProposal.update(
        { messageId },
        { where: { id: { [Op.in]: [...ids] }, status: 'pending' } }
    );
};

/** Pending proposals older than 14 days stop being actionable */
export const expireStaleProposals = async (now: Date): Promise<number> => {
    const cutoff = new Date(now.getTime() - 14 * 24 * 3600 * 1000);
    return PriceChangeProposal.update(
        { status: 'expired', decidedAt: now },
        { where: { status: 'pending', detectedAt: { [Op.lt]: cutoff } } }
    ).then(([affected]) => affected);
};

/**
 * Write one approved row into the table, keeping the windows disjoint:
 * a row starting before it is closed at its start, rows covered by it are
 * removed, a row with the same start is replaced. Runs inside the caller's
 * transaction.
 */
const applyEntry = async (entry: PriceEntry, transaction: Transaction): Promise<void> => {
    const existing = await ModelPriceEntry.findAll({
        where: { model: entry.model, tier: entry.tier },
        order: [['effectiveFrom', 'ASC']],
        transaction,
    });
    const newFrom = entry.effectiveFrom.getTime();
    const newTo = entry.effectiveTo?.getTime() ?? OPEN_END;
    for (const row of existing) {
        const rowFrom = row.effectiveFrom.getTime();
        const rowTo = row.effectiveTo?.getTime() ?? OPEN_END;
        if (!(rowFrom < newTo && newFrom < rowTo)) continue;
        if (rowFrom === newFrom) {
            if (rowTo > newTo && entry.effectiveTo !== undefined) {
                await ModelPriceEntry.create(
                    { ...rowValuesOf(entryOfRow(row)), effectiveFrom: entry.effectiveTo, effectiveTo: row.effectiveTo },
                    { transaction }
                );
            }
            await row.update(rowValuesOf(entry), { transaction });
            return;
        }
        if (rowFrom < newFrom) {
            await row.update({ effectiveTo: entry.effectiveFrom }, { transaction });
            if (rowTo > newTo && entry.effectiveTo !== undefined) {
                await ModelPriceEntry.create(
                    {
                        ...rowValuesOf(entryOfRow(row)),
                        effectiveFrom: entry.effectiveTo,
                        effectiveTo: row.effectiveTo,
                    },
                    { transaction }
                );
            }
            continue;
        }
        if (rowTo <= newTo) {
            await row.destroy({ transaction });
            continue;
        }
        // Row starts inside the new window but outlives it: keep its tail only.
        if (entry.effectiveTo === undefined) {
            await row.destroy({ transaction });
        } else {
            await row.update({ effectiveFrom: entry.effectiveTo }, { transaction });
        }
    }
    await ModelPriceEntry.create(rowValuesOf(entry), { transaction });
};

/** Apply the owner's approval: write the rows, mark the proposals, audit, reload */
export const applyProposals = async (
    ids: readonly number[],
    actorId: number
): Promise<ApplyProposalsResult> => {
    if (ids.length === 0) return { applied: 0, skipped: 0 };
    const decidedAt = new Date();
    let applied = 0;
    await sequelize.transaction(async (transaction) => {
        const rows = await PriceChangeProposal.findAll({
            where: { id: { [Op.in]: [...ids] }, status: 'pending' },
            transaction,
        });
        for (const row of rows) {
            const payload = deserializeEntry(row.payload);
            if (row.kind !== 'expiry') {
                await applyEntry(payload, transaction);
            }
            await row.update({ status: 'approved', decidedAt, decidedBy: actorId }, { transaction });
            await writeSettingsAudit(
                {
                    actorId,
                    scope: 'pricing',
                    key: `${row.model}:${row.tier}`,
                    oldValue: row.baseline,
                    newValue: row.payload,
                },
                { transaction }
            );
            applied += 1;
        }
    });
    await loadModelPrices();
    return { applied, skipped: ids.length - applied };
};

/** Reject without writing anything; kept for the audit trail */
export const rejectProposals = async (ids: readonly number[], actorId: number): Promise<number> => {
    if (ids.length === 0) return 0;
    const decidedAt = new Date();
    let rejected = 0;
    await sequelize.transaction(async (transaction) => {
        const rows = await PriceChangeProposal.findAll({
            where: { id: { [Op.in]: [...ids] }, status: 'pending' },
            transaction,
        });
        for (const row of rows) {
            await row.update({ status: 'rejected', decidedAt, decidedBy: actorId }, { transaction });
            await writeSettingsAudit(
                {
                    actorId,
                    scope: 'pricing',
                    key: `${row.model}:${row.tier}`,
                    oldValue: row.payload,
                    newValue: 'rejected',
                },
                { transaction }
            );
            rejected += 1;
        }
    });
    return rejected;
};

/** Record the start of a watch run; failures are the caller's to log */
export const startWatchRun = async (): Promise<number> => {
    const run = await PriceWatchRun.create({ startedAt: new Date(), outcome: 'skipped', proposals: 0 });
    return run.id;
};

export const finishWatchRun = async (
    runId: number,
    input: {
        readonly outcome: 'ok' | 'failed' | 'skipped';
        readonly proposals?: number;
        readonly notifiedMessageId?: number | null;
        readonly error?: string | null;
    }
): Promise<void> => {
    await PriceWatchRun.update(
        {
            finishedAt: new Date(),
            outcome: input.outcome,
            proposals: input.proposals ?? 0,
            notifiedMessageId: input.notifiedMessageId ?? null,
            error: input.error ?? null,
        },
        { where: { id: runId } }
    );
};
