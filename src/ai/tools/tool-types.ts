/**
 * Client tool contract shared by the platforms and the tool providers.
 *
 * Only contracts live here; concrete tools (SMS, image generation) are built by
 * the reply layer and injected per turn, so the AI layer never imports them.
 */
import type { SniffedMediaMime } from '../image-generation/image-mime.js';
import type { GroundingData, ToolChatAction, ToolStatus } from '../types.js';

export type { ToolChatAction, ToolStatus } from '../types.js';

export interface ToolDefinition {
    /** Name the model sees; unique per turn; ^[A-Za-z_][A-Za-z0-9_-]{0,63}$ */
    readonly name: string;
    readonly description: string;
    /** Object JSON Schema; wire formats adapt it per provider */
    readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ToolCall {
    /** Provider call id; synthesized by the platform when the provider has none */
    readonly id: string;
    readonly name: string;
    /** Raw JSON arguments exactly as the model produced them */
    readonly argumentsJson: string;
}

export interface ToolImage {
    readonly data: Buffer;
    readonly mimeType: string;
    readonly caption?: string;
}

/**
 * An image the model itself should see (thumbnails of a search, a page being
 * checked). Never delivered to the chat: only `images` goes out.
 *
 * `video/mp4` is a GIF re-encoded so the model can watch the motion: a GIF
 * given as an image is read as a single frame. Only platforms whose
 * capabilities say `supportsVideoToolResult` get one (currently Gemini); the
 * other replay paths keep receiving still frames.
 */
export interface ToolModelImage {
    readonly data: Buffer;
    /** PNG / JPEG / WebP, a GIF (bare-URL fallback), or an mp4 made from a GIF */
    readonly mimeType: SniffedMediaMime | 'video/mp4';
    /** Short model-facing label, e.g. `[s3] 标题 — example.com` */
    readonly caption: string;
}

export interface ToolResult {
    /** What the model reads back */
    readonly content: string;
    readonly isError: boolean;
    /** Images that become part of the bot reply */
    readonly images: readonly ToolImage[];
    /** Images only the model sees, replayed after the tool result */
    readonly modelImages?: readonly ToolModelImage[];
    /** Record for the merged Tools/Sources block; null = usage count only */
    readonly record: GroundingData | null;
}

export interface ToolHandler {
    readonly definition: ToolDefinition;
    /** Status line while this tool runs; a generic line when absent */
    readonly statusText?: string;
    /** Chat action while this tool runs; 'typing' when absent */
    readonly chatAction?: ToolChatAction;
    /** Should not throw; the dispatcher converts throws into error results anyway */
    readonly execute: (args: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<ToolResult>;
}

export interface TurnTools {
    readonly definitions: readonly ToolDefinition[];
    /** Never throws: unknown names, bad JSON and handler failures come back as error results */
    readonly execute: (call: ToolCall, signal?: AbortSignal) => Promise<ToolResult>;
    /** What to show while the named tool runs */
    readonly statusOf: (name: string) => ToolStatus;
}
