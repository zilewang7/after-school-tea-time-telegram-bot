/**
 * AI Platform unified types
 */
import type {
    ModelCatalogCapabilities,
    ModelCatalogReasoning,
} from '../config/model-capabilities.js';
import type { PlatformType } from '../config/platform-routing.js';
import type { ToolLoopCheckpoint, ToolLoopCheckpointSink } from './tools/tool-loop-checkpoint.js';
import type { TurnTools } from './tools/tool-types.js';
import type { UsageSink } from './usage/usage-types.js';

// Platform type identifier
export type { PlatformType };

/** Where resolved catalog/seed metadata came from */
export type ModelTraitsOrigin = 'catalog' | 'seed' | 'code';

/** Whether a single trait's active runtime value came from catalog/seed data or code defaults */
export type TraitOrigin = 'data' | 'code';

export interface Trait<T> {
    readonly value: T;
    readonly origin: TraitOrigin;
    readonly codeValue: T;
    readonly dataValue: T | null;
    readonly differs: boolean;
}

export interface RuntimeTraits {
    readonly model: string;
    readonly platform: PlatformType;
    readonly origin: ModelTraitsOrigin;
    readonly inCatalog: boolean;
    readonly catalogVersion: string;
    readonly capabilities: ModelCatalogCapabilities | null;
    readonly imageOutput: Trait<boolean>;
    readonly imageInput: Trait<boolean>;
    readonly mediaInput: Trait<boolean>;
    readonly clientTools: Trait<boolean>;
    readonly geminiToolsMixing: Trait<boolean>;
    readonly imageSearchGrounding: Trait<boolean>;
    readonly xhighThinking: Trait<boolean>;
    readonly requiresMessageMerge: boolean;
    readonly supportsThinking: boolean | undefined;
    readonly supportsVideoToolResult: boolean;
    readonly reasoning: Trait<ModelCatalogReasoning | null>;
    readonly outputTokens: Trait<number | null>;
}

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
    /** Calls of this tool the reply made, failed ones included */
    count: number;
    /** Of those calls, how many the tool answered with an error; absent when none failed */
    failed?: number;
}

/**
 * One executed tool call, as the Tools block's log shows it (design
 * 2026-1119-1835). Collected in `runToolRound` for every offered call the reply
 * executed, in call order; versions stored before it existed have none and keep
 * their legacy rendering.
 */
export interface AgentToolCallRecord {
    /** The tool name the model called, as the usage line shows it */
    name: string;
    /** Display form of the arguments, already truncated, e.g. 「灭蛾 方法」· before=h9 */
    argument?: string;
    /** Display form of the outcome, e.g. 5 条命中; on failure the short reason (the renderer adds 「失败：」) */
    result?: string;
    /** The tool answered with an error; absent when it did not (same scope as AgentToolUsage.failed) */
    failed?: boolean;
    /** Wall time of the handler; shown only when the call was slow */
    ms?: number;
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
    /**
     * Per-call log of the reply, in call order (design 2026-1119-1835). Absent
     * on versions stored before it existed: those keep the legacy Tools block.
     */
    toolCalls?: AgentToolCallRecord[];
    /** Calls dropped by the record safety cap; absent when nothing was dropped */
    toolCallsTruncated?: number;
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
export type ToolChatAction = 'typing' | 'upload_photo' | 'choose_sticker' | 'upload_document';

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
export type StreamChunkType = 'text' | 'thinking' | 'image' | 'sticker' | 'file' | 'widget' | 'grounding' | 'status' | 'done';

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

/**
 * A chat UI card the reply will send as a Telegram HTML widget: the model wrote
 * the A2UI surface or the full HTML with send_widget. The HTML is compiled or
 * prechecked once, here, and the delivery layer only sends it.
 */
export interface WidgetDelivery {
    /** a2ui = compiled from the model's surface JSON; html = written by the model */
    readonly mode: 'a2ui' | 'html';
    /** Final self-contained widget HTML (already size-checked) */
    readonly html: string;
    /** Optional caption shown below the card */
    readonly caption?: string;
    /** UTF-8 bytes of html */
    readonly htmlBytes: number;
    /** zlib level 9 bytes, the number the server enforces */
    readonly zlibBytes: number;
    /** The original A2UI surface, kept so a later turn can read or revise it */
    readonly surface?: unknown;
}

/**
 * A file the reply will send as a Telegram document: the model wrote it with
 * send_file. Bytes, name and mime travel together so the delivery layer, the
 * stored version and the next context all read the same file.
 */
export interface FileDelivery {
    /** Sanitized name the chat downloads, e.g. `SKILL.md` */
    readonly name: string;
    /** Inferred from the extension, e.g. `text/markdown` */
    readonly mimeType: string;
    readonly data: Buffer;
    /** Optional caption; the reply's first one wins */
    readonly caption?: string;
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
    /** The file this reply will send (one per reply, replaces an earlier one) */
    file?: FileDelivery;
    /** The chat UI card this reply will send (one per reply, replaces an earlier one) */
    widget?: WidgetDelivery;
    groundingMetadata?: GroundingData;
    /** Tool status; a status chunk without it clears the status */
    status?: ToolStatus;
    agentStats?: AgentStats;
    rawResponse?: unknown;
    /**
     * Replayed from a checkpoint's journal: content the interrupted version
     * already produced, shown again and not newly generated.
     */
    replay?: boolean;
}

// AI response result
export interface AIResponse {
    text: string;
    thinkingText: string;
    images: Buffer[];
    /** Caption of the first image; the per-image list below is the authority */
    imageCaption?: string;
    /**
     * One caption per image in `images`, same order; an image without a caption
     * keeps an `undefined` slot so the two arrays stay aligned.
     */
    imageCaptions?: (string | undefined)[];
    /** Stickers this reply sends (delivery keeps the first) */
    stickers?: StickerDelivery[];
    /** Files this reply sends (delivery keeps the last) */
    files?: FileDelivery[];
    /** Chat UI cards this reply sends (delivery keeps the first) */
    widgets?: WidgetDelivery[];
    groundingData?: GroundingData[];
    agentStats?: AgentStats;
    modelParts?: unknown[];
    rawResponse?: unknown;
    /** The stream reached its done chunk: nothing of the answer is missing */
    streamEnded?: boolean;
}

/**
 * The thinking effort a reply asks the platform for, settled by the reply
 * layer from the chat's setting and the model's capability data.
 * - absent on PlatformConfig: the platform keeps its legacy hard-coded
 *   behaviour, request for request;
 * - 'default': follow the vendor default, so no level/effort parameter goes
 *   out at all (the provider decides);
 * - 'explicit': send `value` (lower case) as the level/effort parameter;
 * - 'off': disable thinking where the platform can, otherwise behave like
 *   'default'.
 */
export interface ThinkingEffortRequest {
    readonly mode: 'default' | 'explicit' | 'off';
    /** Lower-case effort value for mode 'explicit'; null otherwise */
    readonly value: string | null;
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
    /** The reply's usage collector: the platform reports each round as it finishes */
    usageSink?: UsageSink;
    /**
     * Ask for Vertex Priority PayGo (served at the priority tier when there is
     * capacity, silently at the standard tier otherwise). Only Gemini on our
     * own Vertex reads it; every other lane ignores the field.
     */
    serviceTier?: 'priority';
    /**
     * Thinking effort this request asks for; absent keeps the platform's
     * legacy hard-coded behaviour (see ThinkingEffortRequest).
     */
    thinkingEffort?: ThinkingEffortRequest;
    /**
     * Gets a new checkpoint each time the tool loop reaches a point it could
     * be resumed from; the caller keeps the last one. Only the Gemini tool
     * loop calls it.
     */
    checkpointSink?: ToolLoopCheckpointSink;
    /**
     * Pre-resolved model traits for this reply attempt so every consumer and
     * platform sees one consistent snapshot even if the catalog reloads mid-reply.
     */
    traits?: RuntimeTraits;
    /**
     * Continue an interrupted tool loop: `messages` is ignored, the
     * checkpoint's journal is replayed first (chunks marked `replay`), then
     * the loop opens the round the checkpoint had ready.
     */
    resumeFrom?: ToolLoopCheckpoint;
}

// Model capabilities
export interface ModelCapabilities {
    supportsImageInput: boolean;
    supportsImageOutput: boolean;
    supportsSystemPrompt: boolean;
    requiresMessageMerge: boolean;
    supportsThinking?: boolean;
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
    /** Caption of the first image; the per-image list below is the authority */
    imageCaption?: string;
    /** One caption per image in `images`, same order (`undefined` when absent) */
    imageCaptions?: (string | undefined)[];
    /** Stickers collected so far; only the first is delivered */
    stickers: StickerDelivery[];
    /** Files collected so far; only the last (newest content) is delivered */
    files: FileDelivery[];
    /** Chat UI card collected so far; only the last one is delivered */
    widgets: WidgetDelivery[];
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
