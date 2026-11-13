/**
 * List prices the panel estimates reply costs with (design §6.5, appendix A;
 * pricing design 2026-1113-1150).
 *
 * Since the pricing design the table is **data in SQLite**
 * (`model_price_entries`, append-only effective windows); this module holds:
 * - the `PriceEntry` / `ModelPrice` types,
 * - the in-memory registry the database loader injects (`setPriceEntries`),
 * - the built-in seed rows (what a fresh database is filled with, the fallback
 *   when the database cannot be read, and the reset state in offline tests),
 * - the lookups the cost estimate and the panel use.
 *
 * Nothing here imports db/services: `src/index.ts` loads the table and calls
 * `setPriceEntries`. A model id without an entry is "unpriced"; routes in
 * SUBSCRIPTION_ROUTES cost nothing at the margin.
 *
 * Not in the estimate (the page says so): the relay's group discount on
 * GPT / Claude, Vertex credits and promotional rebates, DeepSeek off-peak
 * (peak price below, so the estimate runs high), Gemini search grounding and
 * xAI server-side tool fees, long-context tiers, and every cost of /picgpt
 * (gpt-image-2.5-dev is a relay-only id without an official price).
 */

/** The three text prices of one service tier, USD per 1M tokens */
export interface TierPrice {
    /** Uncached input tokens */
    readonly inputPerM: number;
    /** Cache-hit input tokens */
    readonly cachedInputPerM: number;
    /** Output tokens; reasoning is billed here too */
    readonly outputPerM: number;
}

export interface ModelPrice extends TierPrice {
    /** Anthropic cache writes; defaults to inputPerM */
    readonly cacheWritePerM?: number;
    /** Image-modality output tokens (Gemini image models) */
    readonly imageOutputPerM?: number;
    /** Per image, only for image rows that carry no usage at all */
    readonly perImageUsd?: number;
    /**
     * Vertex Priority PayGo, for the rounds actually served at the priority
     * tier (design §8.4). Absent: such rounds are estimated at the standard
     * price and the cost says so.
     */
    readonly priority?: TierPrice;
    readonly sourceUrl: string;
    /** YYYY-MM-DD the price was last checked against sourceUrl */
    readonly checkedOn: string;
}

/** Who supplied a price row; the panel shows this verbatim */
export type PriceSource = 'manual' | 'models-dev' | 'official' | 'ephone';

export type PriceTier = 'standard' | 'priority';

export type PriceConfidence = 'high' | 'medium' | 'low';

/**
 * One price row of one model and tier, valid over `[effectiveFrom, effectiveTo)`.
 * Rows are append-only: a price change closes the old row (effectiveTo is the
 * instant the next one starts) and adds a new one. A row without effectiveTo
 * stays open. UTC instants; the end of the window is exclusive.
 */
export interface PriceEntry {
    readonly model: string;
    readonly tier: PriceTier;
    readonly inputPerM: number;
    readonly cachedInputPerM: number;
    readonly cacheWritePerM?: number;
    readonly outputPerM: number;
    readonly imageOutputPerM?: number;
    readonly perImageUsd?: number;
    readonly effectiveFrom: Date;
    readonly effectiveTo?: Date;
    readonly source: PriceSource;
    readonly sourceUrl?: string;
    /** YYYY-MM-DD the value was last checked against the source */
    readonly checkedOn: string;
    readonly confidence: PriceConfidence;
    readonly note?: string;
}

const OPENAI_PRICING = 'https://developers.openai.com/api/docs/pricing';
const ANTHROPIC_PRICING = 'https://platform.claude.com/docs/en/about-claude/pricing';
// Vertex's own page (not the Gemini API one): it is the only source with the
// Priority tier and the promotional windows, and it was readable on 2026-11-13.
const GEMINI_PRICING = 'https://cloud.google.com/vertex-ai/generative-ai/pricing';
const DEEPSEEK_PRICING = 'https://api-docs.deepseek.com/quick_start/pricing';
const XAI_PRICING = 'https://docs.x.ai/developers/pricing';

const utc = (iso: string): Date => new Date(iso);

/** Open-ended start, so every historical reply matches the first row */
const FROM_THE_START = utc('1970-01-01T00:00:00Z');

/** argon/carbon: promotional price through 2026-11-30, doubles on 12-01 */
const GEMINI_4_PROMO_END = utc('2026-12-01T00:00:00Z');
/** gemini-3.8-flash: introductory price through 2026-12-31, doubles on 2027-01-01 */
const GEMINI_3_8_PROMO_END = utc('2027-01-01T00:00:00Z');
const CHECKED_2026_11_13 = '2026-11-13';

/** The text prices of one seed row */
interface SeedValues {
    readonly inputPerM: number;
    readonly cachedInputPerM: number;
    readonly outputPerM: number;
    readonly priority?: TierPrice;
}

interface SeedSpec extends SeedValues {
    readonly model: string;
    readonly cacheWritePerM?: number;
    readonly imageOutputPerM?: number;
    readonly perImageUsd?: number;
    readonly sourceUrl: string;
    readonly checkedOn: string;
    /** Later windows, e.g. a promotional price that expires at a known instant */
    readonly changes?: readonly ({ readonly from: Date } & SeedValues)[];
}

const entryOf = (
    spec: SeedSpec,
    values: SeedValues,
    from: Date,
    to: Date | undefined
): readonly PriceEntry[] => {
    const base = {
        model: spec.model,
        effectiveFrom: from,
        ...(to === undefined ? {} : { effectiveTo: to }),
        source: 'manual' as const,
        sourceUrl: spec.sourceUrl,
        checkedOn: spec.checkedOn,
        confidence: 'high' as const,
    };
    const priority = values.priority ?? spec.priority;
    return [
        {
            ...base,
            tier: 'standard',
            inputPerM: values.inputPerM,
            cachedInputPerM: values.cachedInputPerM,
            outputPerM: values.outputPerM,
            ...(spec.cacheWritePerM === undefined ? {} : { cacheWritePerM: spec.cacheWritePerM }),
            ...(spec.imageOutputPerM === undefined ? {} : { imageOutputPerM: spec.imageOutputPerM }),
            ...(spec.perImageUsd === undefined ? {} : { perImageUsd: spec.perImageUsd }),
        },
        ...(priority === undefined
            ? []
            : [
                  {
                      ...base,
                      tier: 'priority' as const,
                      inputPerM: priority.inputPerM,
                      cachedInputPerM: priority.cachedInputPerM,
                      outputPerM: priority.outputPerM,
                  },
              ]),
    ];
};

/** One seed spec becomes one row per window; the first window is open-ended early */
const seedEntriesFor = (spec: SeedSpec): readonly PriceEntry[] => {
    const windows: { readonly from: Date; readonly to: Date | undefined; readonly values: SeedValues }[] = [];
    let from: Date = FROM_THE_START;
    let values: SeedValues = spec;
    for (const change of spec.changes ?? []) {
        windows.push({ from, to: change.from, values });
        from = change.from;
        values = change;
    }
    windows.push({ from, to: undefined, values });
    return windows.flatMap((window) => entryOf(spec, window.values, window.from, window.to));
};

/**
 * Built-in seed rows: what a fresh database is filled with, and the fallback
 * when the database cannot be read. Official list prices (design appendix A),
 * USD per 1M tokens, with the promotional windows the Vertex page had on
 * 2026-11-13.
 */
export const SEED_SPECS: readonly SeedSpec[] = [
    // >272K input: the whole request at 0.20 / 0.02 / 0.75 (not modelled)
    { model: 'gpt-6-luna', inputPerM: 0.1, cachedInputPerM: 0.01, outputPerM: 0.5, sourceUrl: OPENAI_PRICING, checkedOn: '2026-11-07' },
    // Also the base model of image chat; >272K: 4 / 0.40 / 15
    { model: 'gpt-6-sol', inputPerM: 2, cachedInputPerM: 0.2, outputPerM: 10, sourceUrl: OPENAI_PRICING, checkedOn: '2026-11-07' },
    // >272K: 20 / 2 / 75
    { model: 'gpt-6-astra', inputPerM: 10, cachedInputPerM: 1, outputPerM: 50, sourceUrl: OPENAI_PRICING, checkedOn: '2026-11-07' },
    // Previous Anthropic id: no longer in the menu, but history still prices it.
    // 5-minute cache writes; the code sends no cache_control, so writes are 0.
    {
        model: 'claude-sonnet-5',
        inputPerM: 2,
        cachedInputPerM: 0.2,
        outputPerM: 10,
        cacheWritePerM: 2.5,
        sourceUrl: ANTHROPIC_PRICING,
        checkedOn: '2026-11-07',
    },
    // The Anthropic id the menu offers since 2026-11-13: cache hits are half
    // of sonnet-5's (0.10 vs 0.20)
    {
        model: 'claude-sonnet-5-5',
        inputPerM: 2,
        cachedInputPerM: 0.1,
        outputPerM: 10,
        cacheWritePerM: 2.5,
        sourceUrl: ANTHROPIC_PRICING,
        checkedOn: CHECKED_2026_11_13,
    },
    {
        model: 'claude-opus-5-5',
        inputPerM: 4,
        cachedInputPerM: 0.2,
        outputPerM: 20,
        cacheWritePerM: 5,
        sourceUrl: ANTHROPIC_PRICING,
        checkedOn: '2026-11-07',
    },
    // Vertex published the standard price on 2026-11-12 (1.50 / 0.075 / 7.50);
    // the 0.75/3.75 this seed used before was the Batch tier, not the standard.
    {
        model: 'gemini-4-hydrogen',
        inputPerM: 1.5,
        cachedInputPerM: 0.075,
        outputPerM: 7.5,
        priority: { inputPerM: 2.7, cachedInputPerM: 0.135, outputPerM: 13.5 },
        sourceUrl: GEMINI_PRICING,
        checkedOn: CHECKED_2026_11_13,
    },
    // No longer offered; replies made before the switch still estimate at this
    // price. Introductory through 2026-12-31, then 1.50 / 0.15 / 7.50.
    {
        model: 'gemini-3.8-flash',
        inputPerM: 0.75,
        cachedInputPerM: 0.075,
        outputPerM: 3.75,
        priority: { inputPerM: 1.35, cachedInputPerM: 0.135, outputPerM: 6.75 },
        sourceUrl: GEMINI_PRICING,
        checkedOn: CHECKED_2026_11_13,
        changes: [
            {
                from: GEMINI_3_8_PROMO_END,
                inputPerM: 1.5,
                cachedInputPerM: 0.15,
                outputPerM: 7.5,
                priority: { inputPerM: 2.7, cachedInputPerM: 0.27, outputPerM: 13.5 },
            },
        ],
    },
    // Promotional through 2026-11-30; from 12-01: 4 / 0.20 / 20, priority 7.20 / 0.36 / 36
    {
        model: 'gemini-4-argon',
        inputPerM: 2,
        cachedInputPerM: 0.1,
        outputPerM: 10,
        priority: { inputPerM: 3.6, cachedInputPerM: 0.18, outputPerM: 18 },
        sourceUrl: GEMINI_PRICING,
        checkedOn: CHECKED_2026_11_13,
        changes: [
            {
                from: GEMINI_4_PROMO_END,
                inputPerM: 4,
                cachedInputPerM: 0.2,
                outputPerM: 20,
                priority: { inputPerM: 7.2, cachedInputPerM: 0.36, outputPerM: 36 },
            },
        ],
    },
    // argon's price, promotion and 2026-12-01 change included (design §8.1)
    {
        model: 'gemini-4-carbon',
        inputPerM: 2,
        cachedInputPerM: 0.1,
        outputPerM: 10,
        priority: { inputPerM: 3.6, cachedInputPerM: 0.18, outputPerM: 18 },
        sourceUrl: GEMINI_PRICING,
        checkedOn: CHECKED_2026_11_13,
        changes: [
            {
                from: GEMINI_4_PROMO_END,
                inputPerM: 4,
                cachedInputPerM: 0.2,
                outputPerM: 20,
                priority: { inputPerM: 7.2, cachedInputPerM: 0.36, outputPerM: 36 },
            },
        ],
    },
    // Text output 7.50, image output 30; a 1K image is ~1120 tokens ≈ $0.0336
    {
        model: 'gemini-nano-banana-2.1',
        inputPerM: 1.5,
        cachedInputPerM: 0.15,
        outputPerM: 7.5,
        imageOutputPerM: 30,
        perImageUsd: 0.0336,
        priority: { inputPerM: 2.7, cachedInputPerM: 0.27, outputPerM: 13.5 },
        sourceUrl: GEMINI_PRICING,
        checkedOn: CHECKED_2026_11_13,
    },
    // Peak price (Mon-Fri 01:00-04:00 and 06:00-10:00 UTC); off-peak is half
    { model: 'deepseek-flash', inputPerM: 0.3, cachedInputPerM: 0.006, outputPerM: 1.2, sourceUrl: DEEPSEEK_PRICING, checkedOn: '2026-11-07' },
    // Prompt >= 200K: the whole request at 4 / 1 / 12 (not modelled)
    { model: 'grok-4.7', inputPerM: 2, cachedInputPerM: 0.5, outputPerM: 6, sourceUrl: XAI_PRICING, checkedOn: '2026-11-06' },
    // >= 200K: 2.50 / 0.40 / 5; how sub-agent tokens bill is not documented
    {
        model: 'grok-4.20-multi-agent-0309',
        inputPerM: 1.25,
        cachedInputPerM: 0.2,
        outputPerM: 2.5,
        sourceUrl: 'https://docs.x.ai/docs/models/grok-4.20-multi-agent-0309',
        checkedOn: '2026-11-06',
    },
    // CNY 1 / 0.02 / 2 on the mainland site; whether the account settles in USD is unknown
    {
        model: 'mimo-v2.6-flash',
        inputPerM: 0.14,
        cachedInputPerM: 0.0028,
        outputPerM: 0.28,
        sourceUrl: 'https://mimo.mi.com/models/mimo-v2.6-flash',
        checkedOn: '2026-11-06',
    },
    // CNY 3 / 0.025 / 6
    {
        model: 'mimo-v2.6-pro',
        inputPerM: 0.435,
        cachedInputPerM: 0.0036,
        outputPerM: 0.87,
        sourceUrl: 'https://mimo.mi.com/models/mimo-v2.6-pro',
        checkedOn: '2026-11-06',
    },
];

/** Subscription lanes: a flat monthly fee, so a reply costs nothing extra */
export const SUBSCRIPTION_ROUTES: ReadonlySet<string> = new Set(['opencode-go']);

const SEED_ENTRIES: readonly PriceEntry[] = SEED_SPECS.flatMap(seedEntriesFor);

/** The built-in seed rows, for the database loader and for test resets */
export const seedPriceEntries = (): readonly PriceEntry[] => SEED_ENTRIES;

interface ModelEntries {
    readonly standard: readonly PriceEntry[];
    readonly priority: readonly PriceEntry[];
}

const byEffectiveFrom = (first: PriceEntry, second: PriceEntry): number =>
    first.effectiveFrom.getTime() - second.effectiveFrom.getTime();

const groupEntries = (entries: readonly PriceEntry[]): Map<string, ModelEntries> => {
    const standard = new Map<string, PriceEntry[]>();
    const priority = new Map<string, PriceEntry[]>();
    for (const entry of entries) {
        const target = entry.tier === 'standard' ? standard : priority;
        const list = target.get(entry.model) ?? [];
        list.push(entry);
        target.set(entry.model, list);
    }
    const byModel = new Map<string, ModelEntries>();
    for (const model of new Set([...standard.keys(), ...priority.keys()])) {
        byModel.set(model, {
            standard: [...(standard.get(model) ?? [])].sort(byEffectiveFrom),
            priority: [...(priority.get(model) ?? [])].sort(byEffectiveFrom),
        });
    }
    return byModel;
};

let entriesByModel = groupEntries(SEED_ENTRIES);
let tableVersion = 'seed';

/** The row in force at `at`: the latest effectiveFrom not after it, still open */
const entryAt = (entries: readonly PriceEntry[], at: Date): PriceEntry | null => {
    const instant = at.getTime();
    let found: PriceEntry | null = null;
    for (const entry of entries) {
        if (entry.effectiveFrom.getTime() > instant) break;
        if (entry.effectiveTo !== undefined && entry.effectiveTo.getTime() <= instant) continue;
        found = entry;
    }
    return found;
};

const toModelPrice = (standard: PriceEntry, priority: PriceEntry | null): ModelPrice => ({
    inputPerM: standard.inputPerM,
    cachedInputPerM: standard.cachedInputPerM,
    outputPerM: standard.outputPerM,
    ...(standard.cacheWritePerM === undefined ? {} : { cacheWritePerM: standard.cacheWritePerM }),
    ...(standard.imageOutputPerM === undefined ? {} : { imageOutputPerM: standard.imageOutputPerM }),
    ...(standard.perImageUsd === undefined ? {} : { perImageUsd: standard.perImageUsd }),
    ...(priority === null
        ? {}
        : {
              priority: {
                  inputPerM: priority.inputPerM,
                  cachedInputPerM: priority.cachedInputPerM,
                  outputPerM: priority.outputPerM,
              },
          }),
    sourceUrl: standard.sourceUrl ?? '',
    checkedOn: standard.checkedOn,
});

/** The model's assembled prices in force at `at`; null for an unpriced model */
export const findPriceAt = (model: string, at: Date): ModelPrice | null => {
    const entries = entriesByModel.get(model);
    if (entries === undefined) return null;
    const standard = entryAt(entries.standard, at);
    if (standard === null) return null;
    return toModelPrice(standard, entryAt(entries.priority, at));
};

/** The model's prices right now (kept for the existing panel and test callers) */
export const findModelPrice = (model: string): ModelPrice | null => findPriceAt(model, new Date());

/** Every price window boundary strictly inside `(from, to)`, oldest first */
export const priceChangeInstants = (from: Date, to: Date): readonly Date[] => {
    const lower = from.getTime();
    const upper = to.getTime();
    const instants = new Set<number>();
    for (const entries of entriesByModel.values()) {
        for (const entry of [...entries.standard, ...entries.priority]) {
            const starts = entry.effectiveFrom.getTime();
            if (starts > lower && starts < upper) instants.add(starts);
            const ends = entry.effectiveTo?.getTime();
            if (ends !== undefined && ends > lower && ends < upper) instants.add(ends);
        }
    }
    return [...instants].sort((a, b) => a - b).map((instant) => new Date(instant));
};

/** Every row currently in the registry (the loader and the watcher diff use it) */
export const allPriceEntries = (): readonly PriceEntry[] =>
    [...entriesByModel.values()].flatMap((entries) => [...entries.standard, ...entries.priority]);

/** The database loader injects the table; [] resets to the built-in seed (tests) */
export const setPriceEntries = (entries: readonly PriceEntry[], version = 'seed'): void => {
    entriesByModel = groupEntries(entries.length === 0 ? SEED_ENTRIES : entries);
    tableVersion = version;
};

/** Opaque version the panel and /api/health show; 'seed' until the DB loads */
export const priceTableVersion = (): string => tableVersion;

/**
 * The current price of every priced model, assembled at load time. Kept for
 * the existing callers and tests; new code should use `findPriceAt`.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.fromEntries(
    [...entriesByModel.keys()].flatMap((model) => {
        const price = findPriceAt(model, new Date());
        return price === null ? [] : [[model, price] as const];
    })
);
