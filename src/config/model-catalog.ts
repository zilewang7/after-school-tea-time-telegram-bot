/**
 * The model catalog the menu and the panel list (pricing design §P6).
 *
 * Like the price table, the catalog is **data in SQLite** (`model_catalog`);
 * this module holds the types, the in-memory registry the database loader
 * injects (`setModelCatalog`), and the built-in fallback built from the menu
 * constants. The capability predicates stay code (`src/ai/model-kinds.ts`):
 * a catalog row says whether a model is offered and what it can do, but code
 * that changes prompts, tools or the image pipeline still ships in a release.
 */
import { GEMINI_IMAGE_MODEL, OPENAI_IMAGE_MODEL, modelConfigs } from './models.js';

export type ModelCatalogKind = 'chat' | 'image';

export type ModelCatalogSource = 'manual' | 'models-dev' | 'official' | 'catalog';

export type ModelCatalogConfidence = 'high' | 'medium' | 'low';

/**
 * What one model can do. Kept close to the models.dev schema-2 capabilities so
 * the watcher can fill it from the catalog; a field missing here means "not
 * known", never "supported".
 */
export interface ModelCatalogCapabilities {
    readonly kind: ModelCatalogKind;
    /** Accepts image input */
    readonly vision: boolean;
    /** Emits images (image generation models) */
    readonly imageOutput: boolean;
    /** Function/tool calling */
    readonly tools: boolean;
    /** Reasoning effort values the model accepts, e.g. ['low','medium','high'] */
    readonly reasoningEffort: readonly string[];
    /** Context window in tokens */
    readonly contextTokens: number | null;
    /** Max output tokens */
    readonly outputTokens: number | null;
}

export interface ModelCatalogEntry {
    readonly id: string;
    readonly label: string;
    /** Platform the prefix routing picks (reported, not yet read by the routing) */
    readonly platform?: string;
    /** The catalog row this came from, e.g. google-vertex/gemini-4-hydrogen */
    readonly catalogKey?: string;
    /** false = known but not offered in the menu (a candidate) */
    readonly enabled: boolean;
    readonly capabilities: ModelCatalogCapabilities;
    readonly source: ModelCatalogSource;
    readonly sourceUrl?: string;
    /** YYYY-MM-DD the row was last checked against the source */
    readonly checkedOn: string;
    readonly confidence: ModelCatalogConfidence;
    readonly note?: string;
}

/** The platform `src/ai/platform-routing.ts` picks for an id, mirrored as data */
export const platformOfModelId = (modelId: string): string => {
    const id = modelId.toLowerCase();
    if (id.startsWith('gemini')) return 'gemini';
    if (id.startsWith('deepseek')) return 'deepseek';
    if (id.startsWith('grok-')) return 'grok';
    if (id.startsWith('mimo')) return 'mimo';
    if (id.startsWith('claude')) return 'anthropic';
    return 'openai';
};

const BASE_CAPABILITIES: ModelCatalogCapabilities = {
    kind: 'chat',
    vision: false,
    imageOutput: false,
    tools: true,
    reasoningEffort: [],
    contextTokens: null,
    outputTokens: null,
};

const imageModelIds = (): ReadonlySet<string> =>
    new Set([OPENAI_IMAGE_MODEL, GEMINI_IMAGE_MODEL].map((id) => id.toLowerCase()));

/** Seed rows: the menu as it ships in code, with conservative capabilities */
export const seedModelCatalogEntries = (): readonly ModelCatalogEntry[] => {
    const images = imageModelIds();
    return modelConfigs.map((model) => {
        const id = model.id.toLowerCase();
        const isImage = images.has(id) || id.includes('image') || id.includes('nano-banana');
        return {
            id: model.id,
            label: model.name,
            platform: platformOfModelId(model.id),
            enabled: true,
            capabilities: isImage
                ? { ...BASE_CAPABILITIES, kind: 'image', imageOutput: true, tools: false }
                : BASE_CAPABILITIES,
            source: 'manual',
            checkedOn: '2026-11-13',
            confidence: 'high',
        };
    });
};

let catalog = new Map<string, ModelCatalogEntry>(seedModelCatalogEntries().map((entry) => [entry.id, entry]));
let catalogVersion = 'seed';

/** The enabled menu entries, in catalog order (fallback order when seeded) */
export const listModelCatalog = (): readonly ModelCatalogEntry[] => {
    const entries = [...catalog.values()].filter((entry) => entry.enabled);
    if (entries.length > 0) return entries;
    return seedModelCatalogEntries().filter((entry) => entry.enabled);
};

/** Every row, enabled or not (the panel's candidate list) */
export const listAllModelCatalog = (): readonly ModelCatalogEntry[] => [...catalog.values()];

export const findModelCatalogEntry = (modelId: string): ModelCatalogEntry | null =>
    catalog.get(modelId) ?? null;

/** The database loader injects the catalog; [] resets to the built-in fallback */
export const setModelCatalog = (entries: readonly ModelCatalogEntry[], version = 'seed'): void => {
    catalog = new Map((entries.length === 0 ? seedModelCatalogEntries() : entries).map((entry) => [entry.id, entry]));
    catalogVersion = version;
};

/** Opaque version the panel and /api/health show; 'seed' until the DB loads */
export const modelCatalogVersion = (): string => catalogVersion;
