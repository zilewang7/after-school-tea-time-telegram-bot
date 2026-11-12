/**
 * List prices the panel estimates reply costs with (design §6.5, appendix A).
 *
 * Official list prices only (relay prices are no basis), USD. Maintained in
 * code: a price change ships with a release and history is re-estimated at
 * the new price. A model id that is not a key here is shown as "unpriced";
 * routes in SUBSCRIPTION_ROUTES cost nothing at the margin. The Gemini chat
 * models also carry their Priority PayGo price (design §8.4).
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

const OPENAI_PRICING = 'https://developers.openai.com/api/docs/pricing';
const ANTHROPIC_PRICING = 'https://platform.claude.com/docs/en/about-claude/pricing';
// The Vertex page (cloud.google.com/model-garden/pricing) could not be read on
// 2026-11-07; Google's Gemini API list price was checked instead
const GEMINI_PRICING = 'https://aistudio.google.com/docs/pricing';
const DEEPSEEK_PRICING = 'https://api-docs.deepseek.com/quick_start/pricing';
const XAI_PRICING = 'https://docs.x.ai/developers/pricing';

// Priority PayGo is 1.8 times the standard price for input, cached input and
// output alike (design §8.1); a downgraded round bills at the standard price
const GEMINI_4_PRIORITY: TierPrice = { inputPerM: 3.6, cachedInputPerM: 0.18, outputPerM: 18 };
const GEMINI_3_8_FLASH_PRIORITY: TierPrice = { inputPerM: 1.35, cachedInputPerM: 0.135, outputPerM: 6.75 };

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
    // >272K input: the whole request at 0.20 / 0.02 / 0.75 (not modelled)
    'gpt-6-luna': { inputPerM: 0.1, cachedInputPerM: 0.01, outputPerM: 0.5, sourceUrl: OPENAI_PRICING, checkedOn: '2026-11-07' },
    // Also the base model of image chat; >272K: 4 / 0.40 / 15
    'gpt-6-sol': { inputPerM: 2, cachedInputPerM: 0.2, outputPerM: 10, sourceUrl: OPENAI_PRICING, checkedOn: '2026-11-07' },
    // >272K: 20 / 2 / 75
    'gpt-6-astra': { inputPerM: 10, cachedInputPerM: 1, outputPerM: 50, sourceUrl: OPENAI_PRICING, checkedOn: '2026-11-07' },
    // 5-minute cache writes; the code sends no cache_control, so writes are normally 0
    'claude-sonnet-5': {
        inputPerM: 2,
        cachedInputPerM: 0.2,
        outputPerM: 10,
        cacheWritePerM: 2.5,
        sourceUrl: ANTHROPIC_PRICING,
        checkedOn: '2026-11-07',
    },
    'claude-opus-5-5': {
        inputPerM: 4,
        cachedInputPerM: 0.2,
        outputPerM: 20,
        cacheWritePerM: 5,
        sourceUrl: ANTHROPIC_PRICING,
        checkedOn: '2026-11-07',
    },
    // Promotional through 2026-12-31; from 2027-01-01: 1.50 / 0.15 / 7.50, priority 2.70 / 0.27 / 13.50
    'gemini-3.8-flash': {
        inputPerM: 0.75,
        cachedInputPerM: 0.075,
        outputPerM: 3.75,
        priority: GEMINI_3_8_FLASH_PRIORITY,
        sourceUrl: GEMINI_PRICING,
        checkedOn: '2026-11-07',
    },
    // Promotional through 2026-11-30; from 2026-12-01: 4 / 0.20 / 20, priority 7.20 / 0.36 / 36 (update both then)
    'gemini-4-argon': {
        inputPerM: 2,
        cachedInputPerM: 0.1,
        outputPerM: 10,
        priority: GEMINI_4_PRIORITY,
        sourceUrl: GEMINI_PRICING,
        checkedOn: '2026-11-07',
    },
    // argon's price, promotion and 2026-12-01 change included (design §8.1)
    'gemini-4-carbon': {
        inputPerM: 2,
        cachedInputPerM: 0.1,
        outputPerM: 10,
        priority: GEMINI_4_PRIORITY,
        sourceUrl: GEMINI_PRICING,
        checkedOn: '2026-11-11',
    },
    // 7.50 is text / thinking output; a 1K image is ~1120 tokens ≈ $0.0336
    'gemini-nano-banana-2.1': {
        inputPerM: 1.5,
        cachedInputPerM: 0.15,
        outputPerM: 7.5,
        imageOutputPerM: 30,
        perImageUsd: 0.0336,
        sourceUrl: GEMINI_PRICING,
        checkedOn: '2026-11-07',
    },
    // Peak price (Mon-Fri 01:00-04:00 and 06:00-10:00 UTC); off-peak is half
    'deepseek-flash': {
        inputPerM: 0.3,
        cachedInputPerM: 0.006,
        outputPerM: 1.2,
        sourceUrl: DEEPSEEK_PRICING,
        checkedOn: '2026-11-07',
    },
    // Prompt >= 200K: the whole request at 4 / 1 / 12 (not modelled)
    'grok-4.7': { inputPerM: 2, cachedInputPerM: 0.5, outputPerM: 6, sourceUrl: XAI_PRICING, checkedOn: '2026-11-06' },
    // >= 200K: 2.50 / 0.40 / 5; how sub-agent tokens bill is not documented
    'grok-4.20-multi-agent-0309': {
        inputPerM: 1.25,
        cachedInputPerM: 0.2,
        outputPerM: 2.5,
        sourceUrl: 'https://docs.x.ai/docs/models/grok-4.20-multi-agent-0309',
        checkedOn: '2026-11-06',
    },
    // CNY 1 / 0.02 / 2 on the mainland site; whether the account settles in USD is unknown
    'mimo-v2.6-flash': {
        inputPerM: 0.14,
        cachedInputPerM: 0.0028,
        outputPerM: 0.28,
        sourceUrl: 'https://mimo.mi.com/models/mimo-v2.6-flash',
        checkedOn: '2026-11-06',
    },
    // CNY 3 / 0.025 / 6
    'mimo-v2.6-pro': {
        inputPerM: 0.435,
        cachedInputPerM: 0.0036,
        outputPerM: 0.87,
        sourceUrl: 'https://mimo.mi.com/models/mimo-v2.6-pro',
        checkedOn: '2026-11-06',
    },
};

/** Subscription lanes: a flat monthly fee, so a reply costs nothing extra */
export const SUBSCRIPTION_ROUTES: ReadonlySet<string> = new Set(['opencode-go']);

/** The model's list price; null for any id the table does not know */
export const findModelPrice = (model: string): ModelPrice | null =>
    Object.hasOwn(MODEL_PRICES, model) ? MODEL_PRICES[model] ?? null : null;
