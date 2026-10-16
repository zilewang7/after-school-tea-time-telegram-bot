/**
 * Loose readers for xAI response JSON. xAI adds fields the SDK types do not
 * know (citations, server-side tool usage) and may leave typed ones out, so
 * these read the raw shape defensively.
 */
import type { Response } from 'openai/resources/responses/responses';
import { isJsonObject } from '../../../shared/json-object.js';

/** The value when it is a list, otherwise an empty one */
export const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A field of a JSON object; undefined for anything else */
export const fieldOf = (value: unknown, key: string): unknown =>
    isJsonObject(value) ? value[key] : undefined;

/** Enough of a Response to read: an id and an output list */
export const isResponseObject = (value: unknown): value is Response =>
    isJsonObject(value) && typeof value.id === 'string' && Array.isArray(value.output);
