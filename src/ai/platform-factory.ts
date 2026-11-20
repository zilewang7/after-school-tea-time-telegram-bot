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
import { capabilitiesOf, resolveRuntimeTraits } from './model-traits.js';
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
export const getModelCapabilities = (model: string): ModelCapabilities =>
    capabilitiesOf(resolveRuntimeTraits(model));

/**
 * Check if model is an image generation model
 */
export const isImageModel = (model: string): boolean => isImageOutputModel(model);

/**
 * Send message using the appropriate platform
 * This is the main entry point for sending messages to AI platforms
 */
export const sendMessage = async (
    messages: UnifiedMessage[],
    config: PlatformConfig
): Promise<AsyncIterable<StreamChunk>> => {
    const traits = config.traits ?? resolveRuntimeTraits(config.model);
    const platform = getPlatform(config.model);
    // Only the platform that made a checkpoint can go on from it; any other
    // would ignore it and send `messages` (empty on a resume) as a new turn
    const { resumeFrom } = config;
    if (resumeFrom !== undefined && resumeFrom.platform !== platform.type) {
        throw new Error(`Cannot resume a ${resumeFrom.platform} checkpoint on the ${platform.type} platform (${config.model})`);
    }
    const imageModel = isImageOutputModel(config.model, traits);
    // A resume is left to the platform: it refuses a checkpoint it cannot go on from
    if (imageModel && resumeFrom === undefined && isChatShapedRequest(config)) {
        throw imageModelChatError(config.model);
    }
    const capabilities = capabilitiesOf(traits);

    // Apply model capabilities (filter images, merge messages, etc.)
    const processedMessages = applyModelCapabilities(messages, capabilities);

    // Add isImageModel and pre-resolved traits to config
    const fullConfig: PlatformConfig = {
        ...config,
        traits,
        isImageModel: imageModel,
    };

    return platform.sendMessage(processedMessages, fullConfig);
};
