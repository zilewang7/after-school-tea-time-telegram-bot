/**
 * AI Platform unified types
 */

// Platform type identifier
export type PlatformType = 'openai' | 'gemini' | 'deepseek' | 'grok' | 'mimo';

// Unified content part (compatible with existing ChatContentPart)
export interface UnifiedContentPart {
    type: 'text' | 'image' | 'media';
    text?: string;
    imageData?: string; // base64 encoded image data
    mediaData?: string; // base64 encoded media data (audio/video/other)
    fileUri?: string; // GCS gs:// reference for large media (used instead of inline base64)
    sizeBytes?: number; // original file size in bytes (for logging / observability)
    mimeType?: string; // real MIME type for media (and optionally image)
    mediaKind?: string; // source kind (e.g. video_sticker, animated_sticker, video) for sampling hints
}

// Unified message format
export interface UnifiedMessage {
    role: 'user' | 'assistant' | 'system';
    content: UnifiedContentPart[];
    modelParts?: unknown[]; // Platform-specific parts (e.g., Gemini's parts)
}

export interface GroundingCitation {
    uri: string;
    title?: string;
}

export interface AgentToolUsage {
    name: string;
    count: number;
}

export interface AgentStats {
    mode?: string;
    reasoningTokens?: number;
    toolUsage?: AgentToolUsage[];
    codeInterpreterSummary?: string[];
}

// Search / grounding data
export interface GroundingData {
    provider?: 'google' | 'xai' | 'mcp';
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
    citations?: GroundingCitation[];
}

// Stream chunk types
export type StreamChunkType = 'text' | 'thinking' | 'image' | 'grounding' | 'done';

// Stream chunk
export interface StreamChunk {
    type: StreamChunkType;
    content?: string;
    imageData?: Buffer;
    groundingMetadata?: GroundingData;
    agentStats?: AgentStats;
    rawResponse?: unknown;
}

// AI response result
export interface AIResponse {
    text: string;
    thinkingText: string;
    images: Buffer[];
    groundingData?: GroundingData[];
    agentStats?: AgentStats;
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
    /** AbortSignal for cancelling the request */
    signal?: AbortSignal;
}

// Model capabilities
export interface ModelCapabilities {
    supportsImageInput: boolean;
    supportsImageOutput: boolean;
    supportsSystemPrompt: boolean;
    requiresMessageMerge: boolean;
    supportsThinking: boolean;
    supportsGrounding: boolean;
    /** Audio/video/other non-image inline input (full-modal models) */
    supportsMediaInput: boolean;
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
    /** Current message display buffer (may be reset on split) */
    textBuffer: string;
    /** Current message thinking buffer (may be reset on split) */
    thinkingBuffer: string;
    /** Complete accumulated text (never reset) */
    fullText: string;
    /** Complete accumulated thinking (never reset) */
    fullThinking: string;
    /** Total chars truncated from thinking to avoid telegram flood */
    thinkingTruncatedChars: number;
    images: Buffer[];
    groundingData: GroundingData[];
    agentStats?: AgentStats;
    modelParts?: unknown[];
    rawResponse?: unknown;
    isDone: boolean;
}

// Platform send options (for retry wrapper)
export interface SendOptions {
    timeout: number;
    maxRetries: number;
    onRetry?: (attempt: number, error: Error) => void;
    /** AbortSignal for cancelling the request */
    signal?: AbortSignal;
}

// Default send options
export const defaultSendOptions: SendOptions = {
    timeout: 85000,
    maxRetries: 3,
};
