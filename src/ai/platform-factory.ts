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
 * Env vars a prompt may reference as `{{VAR}}`. Only the bot's own identity for
 * now — the same prompt file is shared by the production and test instances,
 * which are different bots, so a hardcoded handle makes the test bot introduce
 * itself as the production one.
 */
const PROMPT_VARIABLES = ['BOT_USER_NAME', 'BOT_NAME'] as const;

/** Substitute `{{VAR}}` for the allowlisted env vars; unknown ones stay put */
const applyPromptVariables = (prompt: string): string => {
    let result = prompt;
    for (const variable of PROMPT_VARIABLES) {
        const placeholder = `{{${variable}}}`;
        if (!result.includes(placeholder)) continue;
        const value = process.env[variable];
        if (!value) {
            console.warn(`[system-prompt] ${placeholder} is used but ${variable} is not set`);
            continue;
        }
        result = result.replaceAll(placeholder, value);
    }
    return result;
};

/**
 * System prompt source: SYSTEM_PROMPT_FILE (multi-line markdown file, read
 * once at first use) preferred; SYSTEM_PROMPT env var as fallback for setups
 * where mounting a file is inconvenient. Either may reference the bot's
 * identity as `{{BOT_USER_NAME}}` / `{{BOT_NAME}}`.
 */
let cachedSystemPrompt: string | undefined;

export const getSystemPrompt = (): string => {
    if (cachedSystemPrompt !== undefined) return cachedSystemPrompt;

    const promptFile = process.env.SYSTEM_PROMPT_FILE;
    if (promptFile) {
        try {
            cachedSystemPrompt = applyPromptVariables(readFileSync(promptFile, 'utf-8').trim());
            return cachedSystemPrompt;
        } catch (error) {
            console.error(`[system-prompt] failed to read ${promptFile}, falling back to SYSTEM_PROMPT env:`, error);
        }
    }

    cachedSystemPrompt = applyPromptVariables(process.env.SYSTEM_PROMPT || '');
    return cachedSystemPrompt;
};
