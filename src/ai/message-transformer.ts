/**
 * Message format transformer between unified format and platform-specific formats
 */
import { match, P } from 'ts-pattern';
import type { ChatCompletionMessageParam, ChatCompletionContentPart } from 'openai/resources';
import type { UnifiedMessage, UnifiedContentPart, ModelCapabilities } from './types';

// Gemini content types
export interface GeminiPart {
    text?: string;
    inlineData?: {
        mimeType: string;
        data: string;
    };
    thought?: boolean;
    thoughtSignature?: string;
}

export interface GeminiContent {
    role: 'user' | 'model';
    parts: GeminiPart[];
}

/**
 * Transform unified content parts to Gemini parts
 */
const transformToGeminiParts = (
    parts: UnifiedContentPart[],
    options?: { forceSkipThoughtSignature?: boolean }
): GeminiPart[] => {
    return parts.map((part) =>
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
                        mimeType: 'image/png',
                        data: p.imageData ?? '',
                    },
                };
                if (options?.forceSkipThoughtSignature) {
                    imagePart.thoughtSignature = 'skip_thought_signature_validator';
                }
                return imagePart;
            })
            .exhaustive()
    );
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
                .with({ role: 'assistant', modelParts: P.not(P.nullish) }, (m) => ({
                    role: 'model' as const,
                    parts: m.modelParts as GeminiPart[],
                }))
                .with({ role: 'assistant' }, (m) => ({
                    role: 'model' as const,
                    parts: transformToGeminiParts(m.content, {
                        forceSkipThoughtSignature: options?.isImageModel,
                    }),
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
 * Apply model capabilities to messages
 */
export const applyModelCapabilities = (
    messages: UnifiedMessage[],
    capabilities: ModelCapabilities
): UnifiedMessage[] => {
    let result = messages;

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
        .exhaustive();
};
