/**
 * Shared wire helpers for `PlatformConfig.thinkingEffort` (design
 * 2026-1113-1742 §3.3): the ladder a rejected level is downgraded along, the
 * lower-case value mappings the provider SDKs type as literal unions, and the
 * one-400 rejection check every platform applies.
 *
 * A rejection only counts when the provider answers 400 and names the
 * parameter. 401/403/404/429 and transport errors keep their existing
 * classification: downgrading on one of those would silently change the
 * thinking level of a reply that only hit an auth or quota problem.
 */
import { match } from 'ts-pattern';
import type { PlatformConfig } from '../types.js';

/** Ascending effort ladder; a rejected level walks down one step */
const EFFORT_ORDER: readonly string[] = [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra',
];

/** One reply's effort request plus its one-shot downgrade state */
export interface EffortWire {
    readonly mode: 'default' | 'explicit' | 'off';
    readonly value: string | null;
    /** The platform already downgraded once; nothing else may change it */
    degraded: boolean;
}

/** The wire state of a config, or null when the field is absent (legacy path) */
export const effortWireOf = (config: PlatformConfig): EffortWire | null => {
    const effort = config.thinkingEffort;
    if (effort === undefined) return null;
    return { mode: effort.mode, value: effort.value, degraded: false };
};

/** The next lower effort on the ladder, or null at the bottom / for an unknown value */
export const nextLowerEffort = (value: string): string | null => {
    const index = EFFORT_ORDER.indexOf(value.toLowerCase());
    return index > 0 ? (EFFORT_ORDER[index - 1] ?? null) : null;
};

/** The next lower effort the platform actually accepts; null when there is none */
export const nextLowerEffortWithin = (value: string, supported: readonly string[]): string | null => {
    let candidate = nextLowerEffort(value);
    while (candidate !== null) {
        if (supported.includes(candidate)) return candidate;
        candidate = nextLowerEffort(candidate);
    }
    return null;
};

/** The efforts the Responses API's `reasoning.effort` accepts */
export type OpenAIReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** The SDK's ReasoningEffort union, or null for a value the wire does not type */
export const openAIReasoningEffortOf = (value: string): OpenAIReasoningEffort | null =>
    match(value.toLowerCase())
        .returnType<OpenAIReasoningEffort | null>()
        .with('none', () => 'none')
        .with('minimal', () => 'minimal')
        .with('low', () => 'low')
        .with('medium', () => 'medium')
        .with('high', () => 'high')
        .with('xhigh', () => 'xhigh')
        .with('max', () => 'max')
        .otherwise(() => null);

/** The efforts the Messages API's `output_config.effort` accepts */
export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** The SDK's OutputConfig.effort union, or null for a value the wire does not type */
export const anthropicEffortOf = (value: string): AnthropicEffort | null =>
    match(value.toLowerCase())
        .returnType<AnthropicEffort | null>()
        .with('low', () => 'low')
        .with('medium', () => 'medium')
        .with('high', () => 'high')
        .with('xhigh', () => 'xhigh')
        .with('max', () => 'max')
        .otherwise(() => null);

const fieldOf = (value: unknown, key: string): unknown => {
    if (typeof value !== 'object' || value === null) return undefined;
    return Reflect.get(value, key);
};

/** An SDK/transport error's message, with the nested provider message when there is one */
export const errorTextOf = (error: unknown): string => {
    const direct = fieldOf(error, 'message');
    const nested = fieldOf(fieldOf(error, 'error'), 'message');
    const parts: string[] = [];
    if (typeof direct === 'string') parts.push(direct);
    if (typeof nested === 'string') parts.push(nested);
    return parts.join(' ');
};

/** The HTTP status an SDK error carries, when it carries one */
export const httpStatusOfError = (error: unknown): number | null => {
    const status = fieldOf(error, 'status');
    return typeof status === 'number' ? status : null;
};

/**
 * A 400 that blames the parameter named by `pattern`. Every other status is
 * false on purpose: see the module comment.
 */
export const isParamRejection = (error: unknown, pattern: RegExp): boolean =>
    httpStatusOfError(error) === 400 && pattern.test(errorTextOf(error));

/** The warn line every platform prints when it downgrades a rejected level */
export const logEffortFallback = (
    label: string,
    model: string,
    from: string,
    to: string,
    error: unknown
): void => {
    console.warn(
        `[${label}] ${model} rejected thinking effort ${from}; retrying with ${to}: ${errorTextOf(error).slice(0, 200)}`
    );
};
