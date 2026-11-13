/**
 * The model catalog storage (pricing design §P6): what the menu may offer and
 * which models are candidates.
 *
 * The table is seeded from the menu constants on a fresh database, then
 * extended automatically by the price watcher when it sees a new model of a
 * known family (the owner decided "same family enters the menu automatically";
 * its price still needs the owner's approval). Rows are never deleted by a
 * watch run: `enabled=0` is how a model leaves the menu.
 */
import { createHash } from 'node:crypto';
import { ModelCatalogEntryRow } from '../db/modelCatalogDTO.js';
import { writeSettingsAudit } from '../db/queries/settings-audit.js';
import { emptyModelCapabilities, normalizeModelCapabilities } from '../config/model-capabilities.js';
import {
    findModelCatalogEntry,
    seedModelCatalogEntries,
    setModelCatalog,
    type ModelCatalogCapabilities,
    type ModelCatalogEntry,
} from '../config/model-catalog.js';
import { isNewerVersionOfSameLine } from '../shared/model-line.js';

const readRows = async (): Promise<ModelCatalogEntryRow[]> =>
    ModelCatalogEntryRow.findAll({ order: [['id', 'ASC']] });

/** Parse one row's capabilities JSON through the single reader; problems only warn */
const capabilitiesOf = (json: string, modelId: string): ModelCatalogCapabilities => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch (error: unknown) {
        console.warn(
            `[catalog] ${modelId} 的 capabilities JSON 解析失败，按空能力处理：${error instanceof Error ? error.message : String(error)}`
        );
        return emptyModelCapabilities();
    }
    const normalized = normalizeModelCapabilities(parsed);
    if (normalized.warnings.length > 0) {
        console.warn(`[catalog] ${modelId} 的 capabilities 有未知值：${normalized.warnings.join('；')}`);
    }
    return normalized.capabilities;
};

const entryOfRow = (row: ModelCatalogEntryRow): ModelCatalogEntry => ({
    id: row.id,
    label: row.label,
    ...(row.platform === null ? {} : { platform: row.platform }),
    ...(row.catalogKey === null ? {} : { catalogKey: row.catalogKey }),
    enabled: row.enabled !== 0,
    capabilities: capabilitiesOf(row.capabilities, row.id),
    source: row.source === 'models-dev' || row.source === 'official' || row.source === 'catalog'
        ? row.source
        : 'manual',
    ...(row.sourceUrl === null ? {} : { sourceUrl: row.sourceUrl }),
    checkedOn: row.checkedOn,
    confidence: row.confidence === 'high' ? 'high' : row.confidence === 'low' ? 'low' : 'medium',
    ...(row.note === null ? {} : { note: row.note }),
});

interface NewCatalogRow {
    readonly id: string;
    readonly label: string;
    readonly platform: string | null;
    readonly catalogKey: string | null;
    readonly enabled: number;
    readonly capabilities: string;
    readonly source: string;
    readonly sourceUrl: string | null;
    readonly checkedOn: string;
    readonly confidence: string;
    readonly note: string | null;
}

const rowValuesOf = (entry: ModelCatalogEntry): NewCatalogRow => ({
    id: entry.id,
    label: entry.label,
    platform: entry.platform ?? null,
    catalogKey: entry.catalogKey ?? null,
    enabled: entry.enabled ? 1 : 0,
    capabilities: JSON.stringify(entry.capabilities),
    source: entry.source,
    sourceUrl: entry.sourceUrl ?? null,
    checkedOn: entry.checkedOn,
    confidence: entry.confidence,
    note: entry.note ?? null,
});

/**
 * The version the panel and /api/health report: a content hash of the rows and
 * their capabilities JSON, not a timestamp, so applying a capability proposal
 * moves it even on the same day (design §6).
 */
const versionOf = (rows: readonly ModelCatalogEntryRow[]): string => {
    if (rows.length === 0) return 'seed';
    const hash = createHash('sha256');
    hash.update(String(rows.length));
    for (const row of [...rows].sort((first, second) => first.id.localeCompare(second.id))) {
        hash.update(`${row.id}:${row.capabilities}\n`);
    }
    return `m${hash.digest('hex').slice(0, 12)}-${rows.length}`;
};

/**
 * Load the catalog into the in-memory registry, seeding a fresh database from
 * the menu constants. Never throws: on failure the registry keeps the built-in
 * fallback (the menu as it ships in code).
 */
export const loadModelCatalog = async (): Promise<void> => {
    try {
        let rows = await readRows();
        if (rows.length === 0) {
            const seed = seedModelCatalogEntries();
            await ModelCatalogEntryRow.bulkCreate(seed.map((entry) => rowValuesOf(entry)));
            rows = await readRows();
            console.log(`[catalog] seeded ${rows.length} models`);
        }
        setModelCatalog(rows.map(entryOfRow), versionOf(rows));
        console.log(`[catalog] loaded ${rows.length} models`);
    } catch (error: unknown) {
        console.error('[catalog] loading the model catalog failed, using the built-in menu:', error);
    }
};

/** Every row, enabled or not (the panel's candidate list) */
export const listCatalogRows = async (): Promise<readonly ModelCatalogEntry[]> =>
    (await readRows()).map(entryOfRow);

export const findCatalogRow = async (id: string): Promise<ModelCatalogEntry | null> => {
    const row = await ModelCatalogEntryRow.findByPk(id);
    return row === null ? null : entryOfRow(row);
};

/**
 * The rows a new model replaces: when a newer version of one product line
 * enters, the older version leaves the menu (`enabled=0`) — the owner's "a
 * minor version upgrades itself" decision. The row stays for history and price
 * data, and a different line (another persona) is untouched.
 */
const retireSuperseded = async (candidate: ModelCatalogEntry, actorId: number | null): Promise<void> => {
    const enabledRows = await ModelCatalogEntryRow.findAll({ where: { enabled: 1 } });
    for (const row of enabledRows) {
        if (row.id === candidate.id) continue;
        if (!isNewerVersionOfSameLine(candidate.id, row.id)) continue;
        await row.update({ enabled: 0 });
        if (actorId !== null) {
            await writeSettingsAudit({
                actorId,
                scope: 'model-catalog',
                key: `${row.id}:enabled`,
                oldValue: 'true',
                newValue: 'false',
            });
        }
    }
};

/**
 * Auto-add models the watcher found (the owner approved "same family enters the
 * menu automatically"). Existing rows are left alone, so a manually disabled
 * model never comes back by itself. Returns the ids actually added.
 */
export const addCatalogModels = async (
    candidates: readonly ModelCatalogEntry[],
    actorId: number | null
): Promise<readonly string[]> => {
    const added: string[] = [];
    for (const candidate of candidates) {
        if (findModelCatalogEntry(candidate.id) !== null) continue;
        const existing = await ModelCatalogEntryRow.findByPk(candidate.id);
        if (existing !== null) continue;
        await ModelCatalogEntryRow.create(rowValuesOf(candidate));
        if (actorId !== null) {
            await writeSettingsAudit({
                actorId,
                scope: 'model-catalog',
                key: candidate.id,
                oldValue: null,
                newValue: JSON.stringify(candidate.capabilities),
            });
        }
        await retireSuperseded(candidate, actorId);
        added.push(candidate.id);
    }
    if (added.length > 0) await loadModelCatalog();
    return added;
};
