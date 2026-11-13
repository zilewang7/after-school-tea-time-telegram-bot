/**
 * Contracts of the capability half of the watch run (thinking-effort design
 * 2026-1113-1742 §2.3): what one upstream document asserts about one model, the
 * candidate those documents merge into, and the proposal draft the differ
 * returns for owner approval.
 *
 * `CapabilityPatch` is deliberately narrower than `ModelCatalogCapabilities`: it
 * can only express the fields upstream catalogs assert and it has no
 * `toolsMixing`/`nativeTools`/provenance slots, so a watcher run can never
 * propose those (design rule §1.1-9).
 */
import type {
    ModelCatalogApis,
    ModelCatalogCapabilities,
    ModelCatalogConfidence,
    ModelCatalogKind,
    ModelCatalogModalities,
    ModelEffort,
} from '../config/model-capabilities.js';
import type { CatalogModelRef } from './price-catalog-types.js';

/** Where one observation was read from, lowest priority first */
export type CapabilityObservationOrigin = 'api-json' | 'lab-toml' | 'provider-toml';

/** The part of the reasoning section one document can assert */
export interface CapabilityReasoningPatch {
    readonly supported?: boolean;
    readonly toggle?: boolean;
    readonly efforts?: readonly ModelEffort[];
    readonly defaultEffort?: ModelEffort | null;
    readonly defaultEnabled?: boolean | null;
}

/**
 * The capability fields upstream asserts for one model. Absent = not asserted:
 * a missing field is never written as "no" by the compiler or the differ.
 */
export interface CapabilityPatch {
    readonly kind?: ModelCatalogKind;
    readonly vision?: boolean;
    readonly imageOutput?: boolean;
    readonly tools?: boolean;
    readonly contextTokens?: number;
    readonly outputTokens?: number;
    readonly modalities?: ModelCatalogModalities;
    readonly reasoning?: CapabilityReasoningPatch;
    readonly apis?: ModelCatalogApis;
}

/** What one document says about one model */
export interface CapabilityObservation {
    readonly model: string;
    readonly origin: CapabilityObservationOrigin;
    readonly patch: CapabilityPatch;
}

/** One model the catalogs say something about, after the source-priority merge */
export interface CapabilityCandidate {
    readonly model: string;
    readonly patch: CapabilityPatch;
    /** YYYY-MM-DD of the run */
    readonly checkedOn: string;
    /** The documents that contributed at least one assertion */
    readonly origins: readonly CapabilityObservationOrigin[];
}

export interface CapabilityCompileOptions {
    /** Fixed clock in tests; the run's start time in production */
    readonly now: Date;
    /** The models to compile; defaults to every ref the catalog knows */
    readonly refs?: readonly CatalogModelRef[];
    /** The models.dev aggregate body (the discovery flow already downloaded it) */
    readonly apiJson?: string | null;
}

export interface CapabilityCompileResult {
    readonly candidates: readonly CapabilityCandidate[];
    readonly warnings: readonly string[];
}

/** One changed field as the approval message renders it, e.g. 上下文上限 1,048,576 → 1,000,000 */
export interface CapabilityFieldChange {
    /** `contextTokens`, `reasoning.efforts`, `apis.responses.tools`, ... */
    readonly field: string;
    readonly oldValue: string;
    readonly newValue: string;
}

/** One change the watcher asks the owner to approve */
export interface CapabilityProposalDraft {
    readonly model: string;
    /** Full schema-1 object to write after approval: the current data overlaid with the candidate */
    readonly payload: ModelCatalogCapabilities;
    /** The row's current capabilities; null = no capability data before */
    readonly baseline: ModelCatalogCapabilities | null;
    readonly changes: readonly CapabilityFieldChange[];
    /** One Chinese line: which fields change and where the values came from */
    readonly note: string;
    readonly checkedOn: string;
}

export interface CapabilityDiffOptions {
    /** Fixed clock in tests; the run's start time in production */
    readonly now: Date;
    /** Per-run cap; defaults to `MAX_CAPABILITY_PROPOSALS_PER_RUN` */
    readonly maxProposals?: number;
    /** Rows the same run just auto-added: their capabilities wait for the next run */
    readonly justAddedModels?: readonly string[];
}

export interface CapabilityDiffResult {
    readonly drafts: readonly CapabilityProposalDraft[];
    readonly warnings: readonly string[];
}

/** Risk control: at most this many capability proposals per watch run */
export const MAX_CAPABILITY_PROPOSALS_PER_RUN = 8;

/** Every upstream-only proposal is attributed to models.dev with medium confidence */
export const CAPABILITY_UPSTREAM_SOURCE = 'models-dev';
export const CAPABILITY_PROPOSAL_CONFIDENCE: ModelCatalogConfidence = 'medium';
