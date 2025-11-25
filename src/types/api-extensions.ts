/**
 * Type extensions for third-party APIs with incomplete type definitions
 */

import { ChatCompletionChunk } from "openai/resources";
import { GroundingMetadata } from "@google/generative-ai";

// DeepSeek extends OpenAI API with reasoning_content for reasoner models
export interface DeepSeekDelta {
    content?: string | null;
    reasoning_content?: string;
}

export interface DeepSeekChatCompletionChunk extends Omit<ChatCompletionChunk, 'choices'> {
    choices: Array<{
        delta: DeepSeekDelta;
        index: number;
        finish_reason: string | null;
    }>;
}

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
