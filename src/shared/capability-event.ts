/**
 * Capability contradiction/fallback events observed during live traffic
 * (design 2026-1114-0510 §3.3). Stored as a JSON array on `reply_metrics`
 * (`capabilityEvents`) and scanned by the watcher to emit `traffic` proposals.
 *
 * Lives in `src/shared` (layer 0) so `ai`, `db`, `services` and `panel` share
 * one discriminated union without upward imports or type casts.
 */
import { match } from 'ts-pattern';
import { isJsonObject } from './json-object.js';

export const CAPABILITY_EVENT_KINDS = [
    'effort_rejected',
    'thinking_budget_fallback',
    'tools_rejected',
    'media_rejected',
    'max_tokens_downgraded',
    'output_truncated',
] as const;

export type CapabilityEventKind = (typeof CAPABILITY_EVENT_KINDS)[number];

export type CapabilityEvent =
    | {
          readonly kind: 'effort_rejected';
          readonly effort: string;
          readonly fallback?: string | null;
      }
    | {
          readonly kind: 'thinking_budget_fallback';
          readonly from?: string | null;
      }
    | {
          readonly kind: 'tools_rejected';
      }
    | {
          readonly kind: 'media_rejected';
          readonly modality?: string | null;
      }
    | {
          readonly kind: 'max_tokens_downgraded';
          readonly from: number;
          readonly to: number;
      }
    | {
          readonly kind: 'output_truncated';
          readonly reason?: string | null;
          readonly limit?: number | null;
      };

/** Cap stored events per attempt so a pathological loop never bloats the row */
export const MAX_CAPABILITY_EVENTS_PER_ATTEMPT = 50;

const nonEmptyString = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 64) : null;

const optionalString = (value: unknown): string | null | undefined => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return nonEmptyString(value);
};

const positiveInteger = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;

const optionalPositiveInteger = (value: unknown): number | null | undefined => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return positiveInteger(value);
};

const parseOneEvent = (value: unknown): CapabilityEvent | null => {
    if (!isJsonObject(value) || typeof value.kind !== 'string') return null;
    return match(value.kind)
        .returnType<CapabilityEvent | null>()
        .with('effort_rejected', () => {
            const effort = nonEmptyString(value.effort);
            if (effort === null) return null;
            const fallback = optionalString(value.fallback);
            return fallback === undefined ? { kind: 'effort_rejected', effort } : { kind: 'effort_rejected', effort, fallback };
        })
        .with('thinking_budget_fallback', () => {
            const from = optionalString(value.from);
            return from === undefined ? { kind: 'thinking_budget_fallback' } : { kind: 'thinking_budget_fallback', from };
        })
        .with('tools_rejected', () => ({ kind: 'tools_rejected' }))
        .with('media_rejected', () => {
            const modality = optionalString(value.modality);
            return modality === undefined ? { kind: 'media_rejected' } : { kind: 'media_rejected', modality };
        })
        .with('max_tokens_downgraded', () => {
            const from = positiveInteger(value.from);
            const to = positiveInteger(value.to);
            if (from === null || to === null) return null;
            return { kind: 'max_tokens_downgraded', from, to };
        })
        .with('output_truncated', () => {
            const reason = optionalString(value.reason);
            const limit = optionalPositiveInteger(value.limit);
            return {
                kind: 'output_truncated',
                ...(reason === undefined ? {} : { reason }),
                ...(limit === undefined ? {} : { limit }),
            };
        })
        .otherwise(() => null);
};

/** Parse stored JSON array (or in-memory array); invalid entries are skipped */
export const parseCapabilityEvents = (value: unknown): CapabilityEvent[] => {
    let items: unknown = value;
    if (typeof value === 'string') {
        if (value === '') return [];
        try {
            items = JSON.parse(value);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(items)) return [];
    const parsed: CapabilityEvent[] = [];
    for (const item of items) {
        const event = parseOneEvent(item);
        if (event !== null) parsed.push(event);
        if (parsed.length >= MAX_CAPABILITY_EVENTS_PER_ATTEMPT) break;
    }
    return parsed;
};

/** Stored JSON of an attempt's capability events; NULL when none occurred */
export const serializeCapabilityEvents = (events: readonly CapabilityEvent[]): string | null =>
    events.length === 0 ? null : JSON.stringify(events.slice(0, MAX_CAPABILITY_EVENTS_PER_ATTEMPT));
