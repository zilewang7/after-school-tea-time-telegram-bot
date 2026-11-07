/**
 * Token usage on chat.completions streams (DeepSeek, MiMo): requested with
 * stream_options, it arrives on the stream's last chunk, whose choices are
 * empty (the existing `choices[0]?.delta` reads are safe with it).
 */
import { isJsonObject } from '../../../shared/json-object.js';

/** Ask for the usage chunk at the end of every stream */
export const INCLUDE_USAGE_STREAM_OPTIONS = { include_usage: true };

/** A chunk's usage, read loosely; undefined when the chunk carries none */
export const usageOfChunk = (chunk: unknown): unknown => (isJsonObject(chunk) ? chunk.usage ?? undefined : undefined);
