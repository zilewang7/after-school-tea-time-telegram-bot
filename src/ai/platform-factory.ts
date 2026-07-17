/**
 * AI Platform factory - creates platform instances based on model name
 */
import { readFileSync } from 'node:fs';
import { match } from 'ts-pattern';
import type { IAIPlatform, ModelCapabilities, PlatformConfig, UnifiedMessage, StreamChunk } from './types.js';
import { GeminiPlatform } from './platforms/gemini-platform.js';
import { OpenAIPlatform } from './platforms/openai-platform.js';
import { DeepSeekPlatform } from './platforms/deepseek-platform.js';
import { GrokPlatform } from './platforms/grok-platform.js';
import { MimoPlatform } from './platforms/mimo-platform.js';
import { applyModelCapabilities } from './message-transformer.js';

// Singleton platform instances - initialized once at module load
const geminiPlatform = new GeminiPlatform();
const openaiPlatform = new OpenAIPlatform();
const deepseekPlatform = new DeepSeekPlatform();
const grokPlatform = new GrokPlatform();
const mimoPlatform = new MimoPlatform();

/**
 * Get platform instance based on model name
 * Uses pre-initialized singleton instances to avoid any runtime overhead
 */
export const getPlatform = (model: string): IAIPlatform => {
    return match(model.toLowerCase())
        .when((m) => m.startsWith('gemini'), () => geminiPlatform)
        .when((m) => m.startsWith('deepseek'), () => deepseekPlatform)
        .when((m) => m.startsWith('grok-'), () => grokPlatform)
        .when((m) => m.startsWith('mimo'), () => mimoPlatform)
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
        .with('gemini', () => 'gemini-3.1-pro-preview')
        .with('openai', () => 'gpt-5.4')
        .with('deepseek', () => 'deepseek-reasoning')
        .with('grok', () => 'grok-4.20-0309-reasoning')
        .with('mimo', () => 'mimo-v2.5-pro')
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
 * System prompt source: SYSTEM_PROMPT_FILE (multi-line markdown file, read
 * once at first use) preferred; SYSTEM_PROMPT env var as fallback for setups
 * where mounting a file is inconvenient.
 */
let cachedSystemPrompt: string | undefined;

export const getSystemPrompt = (): string => {
    if (cachedSystemPrompt !== undefined) return cachedSystemPrompt;

    const promptFile = process.env.SYSTEM_PROMPT_FILE;
    if (promptFile) {
        try {
            cachedSystemPrompt = readFileSync(promptFile, 'utf-8').trim();
            return cachedSystemPrompt;
        } catch (error) {
            console.error(`[system-prompt] failed to read ${promptFile}, falling back to SYSTEM_PROMPT env:`, error);
        }
    }

    cachedSystemPrompt = process.env.SYSTEM_PROMPT || '';
    return cachedSystemPrompt;
};
