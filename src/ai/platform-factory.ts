/**
 * AI Platform factory - creates platform instances based on model name
 */
import { match } from 'ts-pattern';
import type { IAIPlatform, ModelCapabilities, PlatformConfig, UnifiedMessage, StreamChunk } from './types';
import { GeminiPlatform } from './platforms/gemini-platform';
import { OpenAIPlatform } from './platforms/openai-platform';
import { DeepSeekPlatform } from './platforms/deepseek-platform';
import { GrokPlatform } from './platforms/grok-platform';
import { applyModelCapabilities } from './message-transformer';

// Singleton platform instances - initialized once at module load
const geminiPlatform = new GeminiPlatform();
const openaiPlatform = new OpenAIPlatform();
const deepseekPlatform = new DeepSeekPlatform();
const grokPlatform = new GrokPlatform();

/**
 * Get platform instance based on model name
 * Uses pre-initialized singleton instances to avoid any runtime overhead
 */
export const getPlatform = (model: string): IAIPlatform => {
    return match(model.toLowerCase())
        .when((m) => m.startsWith('gemini'), () => geminiPlatform)
        .when((m) => m.startsWith('deepseek'), () => deepseekPlatform)
        .when((m) => m.startsWith('grok-'), () => grokPlatform)
        .otherwise(() => openaiPlatform);
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
export const isImageModel = (model: string): boolean => {
    return match(model.toLowerCase())
        .when((m) => m.includes('image'), () => true)
        .otherwise(() => false);
};

/**
 * Get default model name for a platform type
 */
export const getDefaultModel = (platformType: string): string => {
    return match(platformType)
        .with('gemini', () => 'gemini-2.5-pro')
        .with('openai', () => 'gpt-5-chat-latest')
        .with('deepseek', () => 'deepseek-chat')
        .with('grok', () => 'grok-4-1-fast-non-reasoning')
        .otherwise(() => process.env.DEFAULT_MODEL || 'gpt-5-chat-latest');
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
    const capabilities = platform.getModelCapabilities(config.model);

    // Apply model capabilities (filter images, merge messages, etc.)
    const processedMessages = applyModelCapabilities(messages, capabilities);

    // Add isImageModel to config
    const fullConfig: PlatformConfig = {
        ...config,
        isImageModel: isImageModel(config.model),
    };

    return platform.sendMessage(processedMessages, fullConfig);
};

/**
 * Get system prompt from environment
 */
export const getSystemPrompt = (): string => {
    return process.env.SYSTEM_PROMPT || '';
};
