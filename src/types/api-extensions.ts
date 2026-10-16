/**
 * Type extensions for third-party APIs with incomplete type definitions
 */

import type { ChatCompletionChunk } from "openai/resources";
import type { GroundingMetadata } from "@google/genai";

/**
 * A chat.completions chunk delta plus `reasoning_content`, the thinking text
 * DeepSeek and MiMo stream alongside the answer
 */
export type ReasoningChunkDelta = ChatCompletionChunk.Choice.Delta & {
    readonly reasoning_content?: string | null;
};

// Google Gemini API has inconsistent type definitions
// groundingChunks vs groundingChuncks (typo in SDK types)
export interface GroundingChunk {
    web?: {
        uri?: string;
        title?: string;
    };
}

export interface ExtendedGroundingMetadata extends GroundingMetadata {
    groundingChunks?: GroundingChunk[];
}
