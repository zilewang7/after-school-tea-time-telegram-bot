/**
 * What one streamed Gemini part shows the user.
 */
import { match, P } from 'ts-pattern';
import type { Part } from '@google/genai';
import type { StreamChunk } from '../../types.js';

/**
 * The stream chunk a part becomes, or null for parts that show nothing
 * (function calls, signature carriers without text, draft images).
 */
export const geminiPartToChunk = (part: Part): StreamChunk | null =>
    match(part)
        .returnType<StreamChunk | null>()
        .with({ thought: true, text: P.string }, (p) => ({
            type: 'thinking',
            content: p.text,
        }))
        // Draft images the model sketches while thinking are
        // never the answer: only the final image is yielded
        .with({ thought: true, inlineData: P.nonNullable }, () => null)
        .with({ text: P.string }, (p) => ({
            type: 'text',
            content: p.text,
        }))
        .with(
            { inlineData: { data: P.string, mimeType: P.optional(P.string) } },
            (p) => ({
                type: 'image',
                imageData: Buffer.from(p.inlineData.data, 'base64'),
                imageMimeType: p.inlineData.mimeType,
            })
        )
        .otherwise(() => null);
