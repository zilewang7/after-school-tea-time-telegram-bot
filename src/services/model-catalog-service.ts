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
import { ModelCatalogEntryRow } from '../db/modelCatalogDTO.js';
import { writeSettingsAudit } from '../db/queries/settings-audit.js';
import { isJsonObject } from '../shared/json-object.js';
import {
    findModelCatalogEntry,
    seedModelCatalogEntries,
    setModelCatalog,
    type ModelCatalogCapabilities,
    type ModelCatalogEntry,
} from '../config/model-catalog.js';
import { isNewerVersionOfSameLine } from '../shared/model-line.js';

const DEFAULT_CAPABILITIES: ModelCatalogCapabilities = {
    kind: 'chat',
    vision: false,
    imageOutput: false,
    tools: true,
    reasoningEffort: [],
    contextTokens: null,
    outputTokens: null,
};

const readRows = async (): Promise<ModelCatalogEntryRow[]> =>
    ModelCatalogEntryRow.findAll({ order: [['id', 'ASC']] });

const capabilitiesOf = (json: string): ModelCatalogCapabilities => {
    try {
        const raw: unknown = JSON.parse(json);
        if (!isJsonObject(raw)) return DEFAULT_CAPABILITIES;
        const record = raw;
        const boolean = (key: string, fallback: boolean): boolean => {
            const value = record[key];
            return typeof value === 'boolean' ? value : fallback;
        };
        const numberOrNull = (key: string): number | null => {
            const value = record[key];
            return typeof value === 'number' ? value : null;
        };
        const efforts = Array.isArray(record.reasoningEffort)
            ? record.reasoningEffort.filter((effort): effort is string => typeof effort === 'string')
            : [];
        return {
            kind: record.kind === 'image' ? 'image' : 'chat',
            vision: boolean('vision', false),
            imageOutput: boolean('imageOutput', false),
            tools: boolean('tools', true),
            reasoningEffort: efforts,
            contextTokens: numberOrNull('contextTokens'),
            outputTokens: numberOrNull('outputTokens'),
        };
    } catch {
        return DEFAULT_CAPABILITIES;
    }
};

const entryOfRow = (row: ModelCatalogEntryRow): ModelCatalogEntry => ({
    id: row.id,
    label: row.label,
    ...(row.platform === null ? {} : { platform: row.platform }),
    ...(row.catalogKey === null ? {} : { catalogKey: row.catalogKey }),
    enabled: row.enabled !== 0,
    capabilities: capabilitiesOf(row.capabilities),
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

const versionOf = (rows: readonly ModelCatalogEntryRow[]): string => {
    if (rows.length === 0) return 'seed';
    const newest = rows.reduce(
        (latest, row) => (row.updatedAt.getTime() > latest.getTime() ? row.updatedAt : latest),
        rows[0]!.updatedAt
    );
    return `m${newest.toISOString().slice(0, 10).replace(/-/g, '')}-${rows.length}`;
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
