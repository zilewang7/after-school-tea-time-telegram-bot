/**
 * The turns of the model view as text: text parts verbatim, image and media
 * parts replaced by a one-line placeholder such as `[image 123 KB image/jpeg]`
 * or `[media gs://… 31 MB video/mp4]`. No base64 and no storage path leaves
 * the server.
 */
import { match } from 'ts-pattern';
import type { UnifiedContentPart, UnifiedMessage } from '../../ai/types.js';
import { base64ByteLength, formatByteSize } from './byte-size.js';

export interface ModelViewPart {
    type: UnifiedContentPart['type'];
    /** The text itself, or the placeholder of an image / media part */
    text: string;
}

export interface ModelViewTurn {
    role: UnifiedMessage['role'];
    parts: ModelViewPart[];
}

const placeholder = (label: string, fields: ReadonlyArray<string | null>): string =>
    `[${[label, ...fields.filter((field): field is string => field !== null && field !== '')].join(' ')}]`;

const imagePlaceholder = (part: UnifiedContentPart): string => {
    const bytes = part.sizeBytes ?? (part.imageData ? base64ByteLength(part.imageData) : null);
    return placeholder('image', [bytes === null ? null : formatByteSize(bytes), part.mimeType ?? null]);
};

const mediaPlaceholder = (part: UnifiedContentPart): string => {
    const bytes = part.sizeBytes ?? (part.mediaData ? base64ByteLength(part.mediaData) : null);
    return placeholder('media', [
        part.fileUri ? 'gs://…' : null,
        bytes === null ? null : formatByteSize(bytes),
        part.mimeType ?? null,
    ]);
};

export const toModelViewPart = (part: UnifiedContentPart): ModelViewPart =>
    match(part.type)
        .returnType<ModelViewPart>()
        .with('text', () => ({ type: 'text', text: part.text ?? '' }))
        .with('image', () => ({ type: 'image', text: imagePlaceholder(part) }))
        .with('media', () => ({ type: 'media', text: mediaPlaceholder(part) }))
        .exhaustive();

export const toModelViewTurn = (message: UnifiedMessage): ModelViewTurn => ({
    role: message.role,
    parts: message.content.map(toModelViewPart),
});
