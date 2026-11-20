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

const nonImageModalityOfPart = (part: Part): string | null => {
    const mime = part.inlineData?.mimeType ?? part.fileData?.mimeType;
    if (!mime || mime.startsWith('image/')) return null;
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('video/')) return 'video';
    if (mime === 'application/pdf') return 'pdf';
    return 'non-image';
};

export const nonImageModalityOf = (contents: readonly Content[]): string | null => {
    const modalities = new Set<string>();
    for (const content of contents) {
        for (const part of content.parts ?? []) {
            const modality = nonImageModalityOfPart(part);
            if (modality !== null) modalities.add(modality);
        }
    }
    if (modalities.size === 1) return [...modalities][0] ?? null;
    return modalities.size > 0 ? 'non-image' : null;
};

export const hasNonImageMedia = (contents: readonly Content[]): boolean =>
    contents.some((content) => (content.parts ?? []).some(isNonImageMediaPart));

export const stripNonImageMedia = (contents: readonly Content[]): Content[] =>
    contents.map((content) => ({
        ...content,
        parts: (content.parts ?? []).filter((part) => !isNonImageMediaPart(part)),
    }));
