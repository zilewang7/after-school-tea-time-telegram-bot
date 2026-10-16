/**
 * Plain JSON object check: arrays and null are not objects here
 */
export const isJsonObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
