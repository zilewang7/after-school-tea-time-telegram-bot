/**
 * Some media files (usually bad/unsupported codecs, not a bad MIME) make
 * Vertex reject the WHOLE request with 400 INVALID_ARGUMENT even though the
 * same MIME works for other files. The error is not predictable from the MIME
 * alone, so on 400 with non-image media the request is retried without those
 * media parts instead of failing the whole conversation.
 */
import type { Content, Part } from '@google/genai';

export const isNonImageMediaPart = (part: Part): boolean =>
    Boolean(
        (part.inlineData && !(part.inlineData.mimeType ?? '').startsWith('image/')) ||
        (part.fileData && !(part.fileData.mimeType ?? '').startsWith('image/'))
    );

export const hasNonImageMedia = (contents: readonly Content[]): boolean =>
    contents.some((content) => (content.parts ?? []).some(isNonImageMediaPart));

export const stripNonImageMedia = (contents: readonly Content[]): Content[] =>
    contents.map((content) => ({
        ...content,
        parts: (content.parts ?? []).filter((part) => !isNonImageMediaPart(part)),
    }));
