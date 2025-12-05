/**
 * AI Platform unified types
 */

// Platform type identifier
export type PlatformType = 'openai' | 'gemini' | 'deepseek' | 'grok';

// Unified content part (compatible with existing ChatContentPart)
export interface UnifiedContentPart {
    type: 'text' | 'image';
    text?: string;
    imageData?: string; // base64 encoded image data
}

// Unified message format
export interface UnifiedMessage {
    role: 'user' | 'assistant' | 'system';
    content: UnifiedContentPart[];
    modelParts?: unknown[]; // Platform-specific parts (e.g., Gemini's parts)
}

// Google Search grounding data
export interface GroundingData {
    searchQueries: string[];
    searchEntryPoint?: {
        renderedContent?: string;
    };
    groundingChunks?: Array<{
        web?: {
            uri?: string;
            title?: string;
        };
    }>;
}

// Stream chunk types
export type StreamChunkType = 'text' | 'thinking' | 'image' | 'grounding' | 'done';

// Stream chunk
export interface StreamChunk {
    type: StreamChunkType;
    content?: string;
    imageData?: Buffer;
    groundingMetadata?: GroundingData;
    rawResponse?: unknown;
}

// AI response result
export interface AIResponse {
    text: string;
    thinkingText: string;
    images: Buffer[];
    groundingData?: GroundingData[];
    modelParts?: unknown[];
    rawResponse?: unknown;
}

// Platform configuration
export interface PlatformConfig {
    model: string;
    systemPrompt?: string;
    timeout?: number;
    maxRetries?: number;
    isImageModel?: boolean;
}

// Model capabilities
export interface ModelCapabilities {
    supportsImageInput: boolean;
    supportsImageOutput: boolean;
    supportsSystemPrompt: boolean;
    requiresMessageMerge: boolean;
    supportsThinking: boolean;
    supportsGrounding: boolean;
}

// AI Platform interface
export interface IAIPlatform {
    readonly type: PlatformType;

    /**
     * Send messages and get streaming response
     */
    sendMessage(
        messages: UnifiedMessage[],
        config: PlatformConfig
    ): Promise<AsyncIterable<StreamChunk>>;

    /**
     * Check if platform supports given model
     */
    supportsModel(model: string): boolean;

    /**
     * Get model capabilities
     */
    getModelCapabilities(model: string): ModelCapabilities;
}

// Response state for stream processing
export interface ResponseState {
    textBuffer: string;
    thinkingBuffer: string;
    images: Buffer[];
    groundingData: GroundingData[];
    modelParts?: unknown[];
    isDone: boolean;
}

// Platform send options (for retry wrapper)
export interface SendOptions {
    timeout: number;
    maxRetries: number;
    onRetry?: (attempt: number, error: Error) => void;
}

// Default send options
export const defaultSendOptions: SendOptions = {
    timeout: 85000,
    maxRetries: 3,
};
