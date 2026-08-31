/**
 * Message format transformer between unified format and platform-specific formats
 */
import { match } from 'ts-pattern';
import type { ChatCompletionMessageParam, ChatCompletionContentPart } from 'openai/resources';
import type Anthropic from '@anthropic-ai/sdk';
import type { UnifiedMessage, UnifiedContentPart, ModelCapabilities } from './types.js';
import { isGeminiSupportedMimeType, normalizeMimeType } from './supported-mime.js';

// Gemini content types
export interface GeminiPart {
    text?: string;
    inlineData?: {
        mimeType: string;
        data: string;
    };
    fileData?: {
        mimeType: string;
        fileUri: string;
    };
    videoMetadata?: {
        fps?: number;
    };
    thought?: boolean;
    thoughtSignature?: string;
}

// Short sticker clips (video/animated) are sampled above Gemini's default 1.0 fps
// so the model sees the whole animation, not just the first frame. Regular video
// files keep the default sampling rate.
const STICKER_SAMPLING_FPS = 5;
const STICKER_MEDIA_KINDS = new Set(['video_sticker', 'animated_sticker']);

export interface GeminiContent {
    role: 'user' | 'model';
    parts: GeminiPart[];
}

/**
 * True if a part can be sent to Gemini. Text is always fine; image/media carry
 * binary that Gemini must natively support — an unsupported MIME (e.g.
 * application/zip) would make Vertex reject the entire request.
 */
const isGeminiFeedablePart = (part: UnifiedContentPart): boolean => {
    if (part.type === 'text') return true;
    // Inline images default to image/png (legacy null-mime); media has its real MIME.
    const mime = part.type === 'image' ? (part.mimeType ?? 'image/png') : part.mimeType;
    return isGeminiSupportedMimeType(mime);
};

/**
 * Transform unified content parts to Gemini parts
 */
const transformToGeminiParts = (
    parts: UnifiedContentPart[],
    options?: { forceSkipThoughtSignature?: boolean }
): GeminiPart[] => {
    // Drop parts Gemini can't ingest before building the request — keeps a single
    // unsupported attachment from 400-ing the whole context chain. The message's
    // text hint already tells the model a file was shared.
    const feedableParts = parts.filter((part) => {
        if (isGeminiFeedablePart(part)) return true;
        console.warn(`[gemini] dropping unsupported part (mime=${part.mimeType ?? 'unknown'})`);
        return false;
    });

    return feedableParts.map((part) =>
        match(part)
            .with({ type: 'text' }, (p) => {
                const textPart: GeminiPart = { text: p.text ?? '' };
                if (options?.forceSkipThoughtSignature) {
                    textPart.thoughtSignature = 'skip_thought_signature_validator';
                }
                return textPart;
            })
            .with({ type: 'image' }, (p) => {
                const imagePart: GeminiPart = {
                    inlineData: {
                        mimeType: normalizeMimeType(p.mimeType ?? 'image/png'),
                        data: p.imageData ?? '',
                    },
                };
                if (options?.forceSkipThoughtSignature) {
                    imagePart.thoughtSignature = 'skip_thought_signature_validator';
                }
                return imagePart;
            })
            .with({ type: 'media' }, (p) => {
                const mimeType = normalizeMimeType(p.mimeType ?? 'application/octet-stream');
                // Large media is referenced by gs:// URI (fileData); small media
                // is inlined as base64 (inlineData).
                const mediaPart: GeminiPart = p.fileUri
                    ? { fileData: { mimeType, fileUri: p.fileUri } }
                    : { inlineData: { mimeType, data: p.mediaData ?? '' } };
                // Sample short sticker clips at a higher rate so the whole animation
                // is seen; regular video files keep Gemini's default 1.0 fps.
                if (mimeType.startsWith('video/') && p.mediaKind && STICKER_MEDIA_KINDS.has(p.mediaKind)) {
                    mediaPart.videoMetadata = { fps: STICKER_SAMPLING_FPS };
                }
                if (options?.forceSkipThoughtSignature) {
                    mediaPart.thoughtSignature = 'skip_thought_signature_validator';
                }
                return mediaPart;
            })
            .exhaustive()
    );
};

/**
 * The bot's own turn: its actual reply text (and images) plus whatever the
 * stored modelParts carry.
 *
 * modelParts is NOT the reply — it is the last streamed chunk's parts, so in
 * practice a single `{ text: '', thoughtSignature }`. Using it alone (as this
 * did) replayed every past reply as empty, leaving the model blind to what it
 * had said. It is appended verbatim, purely to carry the thought signature
 * back: rewriting a signed part is what would risk rejection, sitting next to
 * one does not.
 */
const buildGeminiModelParts = (
    message: UnifiedMessage,
    options?: { isImageModel?: boolean }
): GeminiPart[] => {
    const contentParts = transformToGeminiParts(message.content, {
        forceSkipThoughtSignature: options?.isImageModel,
    });
    const storedParts = (message.modelParts ?? []) as GeminiPart[];
    return [...contentParts, ...storedParts];
};

/**
 * Transform unified messages to Gemini format
 */
export const transformToGemini = (
    messages: UnifiedMessage[],
    options?: { isImageModel?: boolean }
): GeminiContent[] => {
    return messages
        .filter((msg) => msg.role !== 'system') // System messages handled separately
        .map((msg) =>
            match(msg)
                .with({ role: 'user' }, (m) => ({
                    role: 'user' as const,
                    parts: transformToGeminiParts(m.content),
                }))
                .with({ role: 'assistant' }, (m) => ({
                    role: 'model' as const,
                    parts: buildGeminiModelParts(m, options),
                }))
                .otherwise(() => ({
                    role: 'user' as const,
                    parts: transformToGeminiParts(msg.content),
                }))
        );
};

/**
 * Transform unified content parts to OpenAI format
 */
const transformToOpenAIParts = (parts: UnifiedContentPart[]): ChatCompletionContentPart[] => {
    return parts.map((part) =>
        match(part)
            .with({ type: 'text' }, (p) => ({
                type: 'text' as const,
                text: p.text ?? '',
            }))
            .with({ type: 'image' }, (p) => ({
                type: 'image_url' as const,
                image_url: {
                    url: `data:image/png;base64,${p.imageData ?? ''}`,
                },
            }))
            .with({ type: 'media' }, (p) => ({
                // OpenAI chat parts can't carry inline audio/video; use a text placeholder
                type: 'text' as const,
                text: `[media: ${p.mimeType ?? 'file'}]`,
            }))
            .exhaustive()
    );
};

/**
 * Transform unified messages to OpenAI format
 */
export const transformToOpenAI = (
    messages: UnifiedMessage[],
    options?: { includeSystemPrompt?: boolean; systemPrompt?: string }
): ChatCompletionMessageParam[] => {
    const result: ChatCompletionMessageParam[] = [];

    // Add system prompt if needed
    if (options?.includeSystemPrompt && options.systemPrompt) {
        result.push({
            role: 'system',
            content: options.systemPrompt,
        });
    }

    messages.forEach((msg) => {
        match(msg)
            .with({ role: 'user' }, (m) => {
                result.push({
                    role: 'user',
                    content: transformToOpenAIParts(m.content),
                });
            })
            .with({ role: 'assistant' }, (m) => {
                // OpenAI assistant messages need string content
                const textContent = m.content
                    .map((part) =>
                        match(part)
                            .with({ type: 'text' }, (p) => p.text ?? '')
                            .with({ type: 'image' }, () => '[assistant image]')
                            .with({ type: 'media' }, () => '[assistant media]')
                            .exhaustive()
                    )
                    .join('\n');

                result.push({
                    role: 'assistant',
                    content: textContent,
                });
            })
            .with({ role: 'system' }, () => {
                // System messages already handled above, skip
            })
            .exhaustive();
    });

    return result;
};

const transformToAnthropicParts = (
    parts: UnifiedContentPart[]
): Anthropic.ContentBlockParam[] => {
    return parts.map((part) =>
        match(part)
            .with({ type: 'text' }, (p): Anthropic.ContentBlockParam => ({
                type: 'text',
                text: p.text ?? '',
            }))
            .with({ type: 'image' }, (p): Anthropic.ContentBlockParam => ({
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: p.imageData ?? '',
                },
            }))
            .with({ type: 'media' }, (p): Anthropic.ContentBlockParam => ({
                // Anthropic messages can't carry inline audio/video; use a text placeholder
                type: 'text',
                text: `[media: ${p.mimeType ?? 'file'}]`,
            }))
            .exhaustive()
    );
};

/**
 * Transform unified messages to Anthropic Messages API format.
 * System messages are skipped (the system prompt goes in the top-level
 * `system` request field).
 */
export const transformToAnthropic = (
    messages: UnifiedMessage[]
): Anthropic.MessageParam[] => {
    const result: Anthropic.MessageParam[] = [];

    messages.forEach((msg) => {
        match(msg)
            .with({ role: 'user' }, (m) => {
                result.push({
                    role: 'user',
                    content: transformToAnthropicParts(m.content),
                });
            })
            .with({ role: 'assistant' }, (m) => {
                const textContent = m.content
                    .map((part) =>
                        match(part)
                            .with({ type: 'text' }, (p) => p.text ?? '')
                            .with({ type: 'image' }, () => '[assistant image]')
                            .with({ type: 'media' }, () => '[assistant media]')
                            .exhaustive()
                    )
                    .join('\n');

                // Anthropic rejects assistant turns with empty text
                if (textContent.trim().length > 0) {
                    result.push({
                        role: 'assistant',
                        content: textContent,
                    });
                }
            })
            .with({ role: 'system' }, () => {
                // Handled via the top-level system field, skip
            })
            .exhaustive();
    });

    // Anthropic requires messages[0] to be a user turn
    if (result.length > 0 && result[0]!.role !== 'user') {
        result.unshift({
            role: 'user',
            content: '[conversation continues]',
        });
    }

    return result;
};

/**
 * Merge consecutive messages of the same role (required for DeepSeek)
 */
export const mergeConsecutiveMessages = (messages: UnifiedMessage[]): UnifiedMessage[] => {
    const result: UnifiedMessage[] = [];
    let currentRole: 'user' | 'assistant' | null = null;
    let currentUserParts: UnifiedContentPart[] = [];
    let currentAssistantText = '';

    const flushCurrent = () => {
        if (currentRole === 'user' && currentUserParts.length > 0) {
            result.push({ role: 'user', content: currentUserParts });
            currentUserParts = [];
        } else if (currentRole === 'assistant' && currentAssistantText.length > 0) {
            result.push({
                role: 'assistant',
                content: [{ type: 'text', text: currentAssistantText }],
            });
            currentAssistantText = '';
        }
    };

    for (const msg of messages) {
        if (msg.role === 'system') continue; // Skip system messages

        if (msg.role !== currentRole) {
            flushCurrent();
            currentRole = msg.role;
        }

        if (msg.role === 'user') {
            currentUserParts = currentUserParts.concat(msg.content);
        } else if (msg.role === 'assistant') {
            const text = msg.content
                .filter((p) => p.type === 'text')
                .map((p) => p.text ?? '')
                .join('');

            if (currentAssistantText.length > 0) {
                currentAssistantText += '\n\n\n';
            }
            currentAssistantText += text;
        }
    }

    flushCurrent();
    return result;
};

/**
 * Filter out image content for models that don't support images
 */
export const filterImageContent = (messages: UnifiedMessage[]): UnifiedMessage[] => {
    return messages.map((msg) => ({
        ...msg,
        content: msg.content.filter((part) => part.type === 'text'),
        modelParts: undefined,
    }));
};

/**
 * Filter out media (audio/video/other) content for models that don't support it.
 * Keeps text and image parts intact.
 */
export const filterMediaContent = (messages: UnifiedMessage[]): UnifiedMessage[] => {
    return messages.map((msg) => ({
        ...msg,
        content: msg.content.filter((part) => part.type !== 'media'),
    }));
};

/**
 * Apply model capabilities to messages
 */
export const applyModelCapabilities = (
    messages: UnifiedMessage[],
    capabilities: ModelCapabilities
): UnifiedMessage[] => {
    let result = messages;

    // Strip media (audio/video) first if not supported
    if (!capabilities.supportsMediaInput) {
        result = filterMediaContent(result);
    }

    // Filter images if not supported
    if (!capabilities.supportsImageInput) {
        result = filterImageContent(result);
    }

    // Merge consecutive messages if required
    if (capabilities.requiresMessageMerge) {
        result = mergeConsecutiveMessages(result);
    }

    return result;
};

/**
 * Convert from legacy ChatContentPart format to UnifiedContentPart
 */
export const fromLegacyContentPart = (part: {
    type: 'text' | 'image_url';
    text?: string;
    image_url?: { url: string };
}): UnifiedContentPart => {
    return match(part)
        .with({ type: 'text' }, (p) => ({
            type: 'text' as const,
            text: p.text,
        }))
        .with({ type: 'image_url' }, (p) => {
            const url = p.image_url?.url ?? '';
            const base64 = url.includes(',') ? url.split(',')[1] : url;
            return {
                type: 'image' as const,
                imageData: base64,
            };
        })
        .exhaustive();
};

/**
 * Convert to legacy ChatContentPart format from UnifiedContentPart
 */
export const toLegacyContentPart = (part: UnifiedContentPart): {
    type: 'text' | 'image_url';
    text?: string;
    image_url?: { url: string };
} => {
    return match(part)
        .with({ type: 'text' }, (p) => ({
            type: 'text' as const,
            text: p.text,
        }))
        .with({ type: 'image' }, (p) => ({
            type: 'image_url' as const,
            image_url: {
                url: `data:image/png;base64,${p.imageData ?? ''}`,
            },
        }))
        .with({ type: 'media' }, (p) => ({
            type: 'text' as const,
            text: `[media: ${p.mimeType ?? 'file'}]`,
        }))
        .exhaustive();
};
