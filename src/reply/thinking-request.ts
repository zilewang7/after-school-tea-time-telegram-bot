/**
 * The thinking-effort part of a reply request (thinking-effort design
 * 2026-1113-1742 §3.4), computed from the chat's raw setting and the effective
 * model: the chat handler, the retry and the continue all build it the same way.
 *
 * Two outcomes share the same rule:
 * - the `platform` fragment is empty when the model has no catalog/seed data
 *   (`source === 'code'`): the platform then keeps its current hard-coded
 *   knowledge-level behaviour, so an unknown model's request is unchanged;
 * - otherwise the fragment carries the resolved mode/value (mode 'default'
 *   included: it tells the platform not to override the vendor default).
 *
 * The `facts` are the reply_metrics values of the attempt: the raw setting, what
 * actually went out, and the degradation chain.
 */
import type { PlatformConfig } from '../ai/types.js';
import { effortFallbackOf, resolveThinkingEffort, sentEffortOf } from '../ai/thinking-effort.js';

/** What reply_metrics records about one request's thinking level */
export interface ThinkingEffortFacts {
    /** The chat setting as it was when the reply started; null = the model default */
    readonly requested: string | null;
    /** The level actually sent after clamping; null = nothing explicit went out */
    readonly sent: string | null;
    /** The degradation chain, e.g. 'xhigh->high'; null = none */
    readonly fallback: string | null;
}

export interface ThinkingRequest {
    /** PlatformConfig fragment; `{}` keeps the legacy request (no data for the model) */
    readonly platform: Pick<PlatformConfig, 'thinkingEffort'>;
    readonly facts: ThinkingEffortFacts;
}

/** Resolve one chat setting for one effective model into the request fragment and its facts */
export const thinkingRequestOf = (model: string, requested: string | null): ThinkingRequest => {
    const resolved = resolveThinkingEffort(model, requested);
    // Design §6: one line per resolution, so an owner can attribute what a reply
    // actually asked for without the metrics table.
    console.log(
        `[thinking] ${model} requested=${requested ?? 'default'} mode=${resolved.mode} value=${resolved.value ?? 'none'} clamped=${String(resolved.clamped)} source=${resolved.source}`
    );
    const facts: ThinkingEffortFacts = {
        requested,
        sent: sentEffortOf(resolved),
        fallback: effortFallbackOf(requested, resolved),
    };
    if (resolved.source === 'code') return { platform: {}, facts };
    return {
        platform: { thinkingEffort: { mode: resolved.mode, value: resolved.value } },
        facts,
    };
};
