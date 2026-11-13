/**
 * Contracts between the pricing pipeline pieces, so they can live in separate
 * modules (and be worked on independently):
 *
 * - the catalog fetcher (`price-catalog-fetch.ts`) downloads TOMLs, the Vertex
 *   pricing page, ephone's pricing JSON and LiteLLM's JSON through an injected
 *   `CatalogFetcher` (offline tests pass a stub, never touch the network);
 * - the compiler (`price-catalog-compile.ts`) turns those documents into
 *   `PriceCandidate` rows (models.dev TOML is the baseline, official Vertex
 *   values win over it, LiteLLM/ephone only warn or fill gaps);
 * - the differ (`price-catalog-compile.ts`) compares the candidates with the
 *   rows currently in force and returns `ProposalDraft`s for the watcher.
 */
import type { PriceConfidence, PriceEntry, PriceSource, PriceTier } from '../config/model-pricing.js';

/** The machine-readable sources the watcher reads */
export type CatalogSourceKind = 'models-dev' | 'official' | 'ephone' | 'litellm';

/** One HTTP GET; status is checked by the caller, body is text (JSON parsed later) */
export type CatalogFetcher = (url: string) => Promise<{ readonly status: number; readonly body: string }>;

/** One model of our menu and where it lives in each catalog */
export interface CatalogModelRef {
    /** Our model id (the key of MODEL_PRICES) */
    readonly model: string;
    /** models.dev provider directory (`openai`, `google-vertex`, ...) */
    readonly provider: string;
    /** models.dev model file name (without `.toml`) */
    readonly modelFile: string;
}

/** The catalog files one run downloaded; a missing source is null + an error entry */
export interface CatalogDocuments {
    /** model → TOML body, only for refs whose fetch answered 200 */
    readonly tomlByModel: ReadonlyMap<string, string>;
    /** The Vertex pricing page body (the only official source with priority/promo) */
    readonly vertexPricingHtml: string | null;
    /** ephone `/api/pricing` body: relay-only ids and the paid-price view */
    readonly ephonePricingJson: string | null;
    /** LiteLLM's JSON: cross-check only */
    readonly litellmJson: string | null;
}

export interface CatalogFetchResult {
    readonly documents: CatalogDocuments;
    /** Non-fatal problems (a single TOML failed, no ephone today, ...) */
    readonly warnings: readonly string[];
    /** Fatal-to-that-source problems; the run still proceeds with the rest */
    readonly errors: readonly string[];
}

/**
 * One price row proposed by the compiler, with its provenance.
 *
 * `entry.effectiveFrom` MUST be either:
 * - the run's `now` (same instant for the whole run, UTC, minute precision) for
 *   the price in force today — never a historical date: a historical candidate
 *   would read as "revert the past" when diffed against rows the owner already
 *   approved; or
 * - the exact boundary of a future scheduled change (date.gte / official
 *   "starting 2026-12-01" → 2026-12-01T00:00:00Z).
 * Only `standard` and `priority` tiers are compiled; past rows are the DB's job.
 */
export interface PriceCandidate {
    readonly entry: PriceEntry;
    readonly sourceKind: CatalogSourceKind;
    /** Short explanation shown to the owner, e.g. "官方 Vertex 页与 models.dev 一致" */
    readonly note: string | null;
}

/** What the compiler found: candidates plus what it could not resolve */
export interface CompileResult {
    readonly candidates: readonly PriceCandidate[];
    readonly warnings: readonly string[];
}

/** One change the watcher wants the owner to approve */
export interface ProposalDraft {
    /** update = replace/close a window; new_model = a model we never priced */
    readonly kind: 'update' | 'new_model' | 'expiry';
    readonly model: string;
    readonly tier: PriceTier;
    /** The row the proposal would write */
    readonly entry: PriceEntry;
    /** The row it replaces (null for a new model or an expiry reminder) */
    readonly baseline: PriceEntry | null;
    /** One line for the Telegram message */
    readonly note: string;
}

/** A price row as the compiler sees the current table (registry snapshot) */
export type CurrentPriceRow = PriceEntry;

/** Options shared by the compiler and the differ */
export interface CompileOptions {
    /** Fixed clock in tests; the run's start time in production */
    readonly now: Date;
    /** The models to compile; defaults to every ref the catalog knows */
    readonly refs?: readonly CatalogModelRef[];
}

/** Relative tolerance below which two prices are "the same" (0.5%) */
export const PRICE_DRIFT_TOLERANCE = 0.005;

/** The source URL a candidate's row should carry, per origin */
export const sourceOf = (kind: CatalogSourceKind): PriceSource =>
    kind === 'models-dev' ? 'models-dev' : kind === 'ephone' ? 'ephone' : 'official';

/** Confidence a proposal gets from its origin */
export const confidenceOf = (kind: CatalogSourceKind): PriceConfidence =>
    kind === 'official' || kind === 'litellm' ? 'high' : kind === 'models-dev' ? 'medium' : 'low';

/** Preference order when two sources disagree on the same row */
export const SOURCE_PRIORITY: Readonly<Record<CatalogSourceKind, number>> = {
    official: 0,
    litellm: 1,
    'models-dev': 2,
    ephone: 3,
};
