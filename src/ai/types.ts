/**
 * AI Platform unified types
 */
import type { TurnTools } from './tools/tool-types.js';

// Platform type identifier
export type PlatformType = 'openai' | 'gemini' | 'deepseek' | 'grok' | 'mimo' | 'anthropic';

// Unified content part (compatible with existing ChatContentPart)
export interface UnifiedContentPart {
    type: 'text' | 'image' | 'media';
    text?: string;
    imageData?: string; // base64 encoded image data
    mediaData?: string; // base64 encoded media data (audio/video/other)
    fileUri?: string; // GCS gs:// reference for large media (used instead of inline base64)
    sizeBytes?: number; // original file size in bytes (for logging / observability)
    durationSeconds?: number; // video length as Telegram reported it (drives frame sampling)
    mimeType?: string; // real MIME type for media (and optionally image)
    mediaKind?: string; // source kind (e.g. video_sticker, animated_sticker, video) for sampling hints
    remoteUrl?: string; // pre-signed https URL for platforms that fetch media themselves (MiMo)
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

/**
 * One paragraph of the reply a grounding chunk supports.
 *
 * `segment.text` is a verbatim slice of the reply and the only reliable
 * locator: the numeric offsets are measured in UTF-8 bytes into a single part
 * and `startIndex` is frequently missing, so they cannot be mapped onto the
 * assembled reply text.
 */
export interface GroundingSupportData {
    segment?: {
        text?: string;
        startIndex?: number;
        endIndex?: number;
        partIndex?: number;
    };
    /** Indices into `groundingChunks` */
    groundingChunkIndices?: number[];
    confidenceScores?: number[];
}

export interface AgentToolUsage {
    name: string;
    count: number;
}

/**
 * One entry of the context user roster, injected into the system prompt so the
 * model can mention (@) people correctly.
 */
export interface ContextUser {
    /** Unknown for a plain @handle mention we have no record of */
    userId?: number;
    /** Handle without the leading @; absent when the user has none / unknown */
    username?: string;
    firstName: string;
    lastName?: string;
    /** true = a bot account (listed apart so the model never @s it) */
    isBot?: boolean;
    /** true = only pointed at in a message, never spoke in this context */
    mentionedOnly: boolean;
}

export interface AgentStats {
    mode?: string;
    reasoningTokens?: number;
    toolUsage?: AgentToolUsage[];
    codeInterpreterSummary?: string[];
}

// Search / grounding data
export interface GroundingData {
    provider?: 'google' | 'xai' | 'mcp' | 'anthropic';
    searchQueries: string[];
    searchEntryPoint?: {
        renderedContent?: string;
    };
    /** Image-search queries of Gemini's image grounding (searchTypes.imageSearch) */
    imageSearchQueries?: string[];
    groundingChunks?: Array<{
        /** A page Google Search grounded the reply on */
        web?: {
            uri?: string;
            title?: string;
        };
        /** A document retrieved by Vertex AI Search (RAG) */
        retrievedContext?: {
            uri?: string;
            title?: string;
            text?: string;
            documentName?: string;
        };
        /** A Google Maps place used as evidence */
        maps?: {
            uri?: string;
            title?: string;
            text?: string;
            placeId?: string;
        };
        /** A grounding image: the page it came from and the image Google served */
        image?: {
            sourceUri?: string;
            imageUri?: string;
            title?: string;
            domain?: string;
        };
    }>;
    /** Paragraph-level citations: which chunks back which slice of the reply */
    groundingSupports?: GroundingSupportData[];
    citations?: GroundingCitation[];
}

// Chat action shown while a tool runs
export type ToolChatAction = 'typing' | 'upload_photo' | 'choose_sticker';

// Transient status line while a tool runs (never persisted)
export interface ToolStatus {
    readonly text: string;
    readonly chatAction: ToolChatAction;
}

// Image output knobs for image models
export interface ImageOutputOptions {
    aspectRatio?: string;
    imageSize?: '1K' | '2K' | '4K';
    /** Replaces the default image-model system instruction for this request */
    instruction?: string;
}

// Stream chunk types
export type StreamChunkType = 'text' | 'thinking' | 'image' | 'sticker' | 'grounding' | 'status' | 'done';

/**
 * A sticker the reply will send: the pack position, the actual picture name,
 * and the resolved file_id. The file_id is what `sendSticker` takes; the rest
 * is what the reply stores so a version switch can send the same sticker
 * again without resolving it from the pack.
 */
export interface StickerDelivery {
    /** 1-based position in the pack (the number the model and the user mean) */
    readonly packIndex: number;
    /** Actual picture name; never the misleading original filename */
    readonly label: string;
    readonly emoji: string;
    readonly fileId: string;
    readonly fileUniqueId: string;
}

// Stream chunk
export interface StreamChunk {
    type: StreamChunkType;
    content?: string;
    imageData?: Buffer;
    /** Real mime of imageData; png when absent */
    imageMimeType?: string;
    /** Caption to send with the image */
    imageCaption?: string;
    /** A sticker this reply will send (one per reply) */
    sticker?: StickerDelivery;
    groundingMetadata?: GroundingData;
    /** Tool status; a status chunk without it clears the status */
    status?: ToolStatus;
    agentStats?: AgentStats;
    rawResponse?: unknown;
}

// AI response result
export interface AIResponse {
    text: string;
    thinkingText: string;
    images: Buffer[];
    /** Caption of the first image */
    imageCaption?: string;
    /** Stickers this reply sends (delivery keeps the first) */
    stickers?: StickerDelivery[];
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
    /**
     * Stable id for the conversation this turn belongs to. Only OpenCode Go
     * reads it today (it wants one session id per conversation); providers that
     * cannot use it ignore the field.
     */
    sessionId?: string;
    /** AbortSignal for cancelling the request */
    signal?: AbortSignal;
    /** Client tools offered this turn; absent = no client tools */
    tools?: TurnTools;
    /** Image model output knobs (aspect ratio, size, instruction) */
    imageOutput?: ImageOutputOptions;
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
    /**
     * Tool results may carry an mp4 (a GIF re-encoded so the model sees the
     * motion). Only the Gemini replay puts media in functionResponse.parts;
     * the others append a user message of images.
     */
    supportsVideoToolResult?: boolean;
    /** Accepts client-side function tools (config.tools) */
    supportsClientTools?: boolean;
    /** False: a request carrying large media (gs:// references) goes out without client tools */
    clientToolsWithLargeMedia?: boolean;
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
    /** Caption of the first image */
    imageCaption?: string;
    /** Stickers collected so far; only the first is delivered */
    stickers: StickerDelivery[];
    /** Status of the running tool; display only, never persisted */
    toolStatus?: ToolStatus;
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
