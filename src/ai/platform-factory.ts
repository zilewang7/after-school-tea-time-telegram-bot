/**
 * AI Platform factory - creates platform instances based on model name
 */
import { match } from 'ts-pattern';
import type { IAIPlatform, ModelCapabilities, PlatformConfig, UnifiedMessage, StreamChunk } from './types.js';
import { GeminiPlatform } from './platforms/gemini-platform.js';
import { OpenAIPlatform } from './platforms/openai-platform.js';
import { DeepSeekPlatform } from './platforms/deepseek-platform.js';
import { GrokPlatform } from './platforms/grok-platform.js';
import { MimoPlatform } from './platforms/mimo-platform.js';
import { AnthropicPlatform } from './platforms/anthropic-platform.js';
import { applyModelCapabilities } from './message-transformer.js';
import { imageModelChatError, isChatShapedRequest } from './image-model-guard.js';
import { isImageOutputModel } from './model-kinds.js';
import { platformTypeOf } from './platform-routing.js';

// Singleton platform instances - initialized once at module load
const geminiPlatform = new GeminiPlatform();
const openaiPlatform = new OpenAIPlatform();
const deepseekPlatform = new DeepSeekPlatform();
const grokPlatform = new GrokPlatform();
const mimoPlatform = new MimoPlatform();
const anthropicPlatform = new AnthropicPlatform();

/**
 * Get platform instance based on model name (routing rule: platformTypeOf)
 * Uses pre-initialized singleton instances to avoid any runtime overhead
 */
export const getPlatform = (model: string): IAIPlatform => {
    return match(platformTypeOf(model))
        .with('gemini', () => geminiPlatform)
        .with('deepseek', () => deepseekPlatform)
        .with('grok', () => grokPlatform)
        .with('mimo', () => mimoPlatform)
        .with('anthropic', () => anthropicPlatform)
        .with('openai', () => openaiPlatform)
        .exhaustive();
};

/**
 * Get model capabilities for a given model
 */
export const getModelCapabilities = (model: string): ModelCapabilities => {
    const platform = getPlatform(model);
    return platform.getModelCapabilities(model);
};

/**
 * Check if model is an image generation model
 */
export const isImageModel = (model: string): boolean => isImageOutputModel(model);

/**
 * Get default model name for a platform type
 */
export const getDefaultModel = (platformType: string): string => {
    return match(platformType)
        .with('gemini', () => 'gemini-4-argon')
        .with('openai', () => 'gpt-5.4')
        .with('deepseek', () => 'deepseek-reasoning')
        .with('grok', () => 'grok-4.20-0309-reasoning')
        .with('mimo', () => 'mimo-v2.6-pro')
        .with('anthropic', () => 'claude-sonnet-5-5')
        .otherwise(() => process.env.DEFAULT_MODEL || 'gpt-5.4');
};

/**
 * Send message using the appropriate platform
 * This is the main entry point for sending messages to AI platforms
 */
export const sendMessage = async (
    messages: UnifiedMessage[],
    config: PlatformConfig
): Promise<AsyncIterable<StreamChunk>> => {
    const platform = getPlatform(config.model);
    // Only the platform that made a checkpoint can go on from it; any other
    // would ignore it and send `messages` (empty on a resume) as a new turn
    const { resumeFrom } = config;
    if (resumeFrom !== undefined && resumeFrom.platform !== platform.type) {
        throw new Error(`Cannot resume a ${resumeFrom.platform} checkpoint on the ${platform.type} platform (${config.model})`);
    }
    const imageModel = isImageModel(config.model);
    // A resume is left to the platform: it refuses a checkpoint it cannot go on from
    if (imageModel && resumeFrom === undefined && isChatShapedRequest(config)) {
        throw imageModelChatError(config.model);
    }
    const capabilities = platform.getModelCapabilities(config.model);

    // Apply model capabilities (filter images, merge messages, etc.)
    const processedMessages = applyModelCapabilities(messages, capabilities);

    // Add isImageModel to config
    const fullConfig: PlatformConfig = {
        ...config,
        isImageModel: imageModel,
    };

    return platform.sendMessage(processedMessages, fullConfig);
};
