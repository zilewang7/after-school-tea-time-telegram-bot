/**
 * Small guards for JSON read from requests and from initData: parsed input is
 * `unknown` until one of these narrows it.
 */
export type JsonRecord = Record<string, unknown>;

export const isJsonRecord = (value: unknown): value is JsonRecord =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** Parse JSON text; undefined when it is not valid JSON */
export const parseJson = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};

export const optionalString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
