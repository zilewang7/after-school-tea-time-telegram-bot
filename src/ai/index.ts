/**
 * AI module - unified AI platform interface
 */

// Types
export * from './types';

// Message transformer
export * from './message-transformer';

// Platform factory
export {
    getPlatform,
    getModelCapabilities,
    isImageModel,
    getDefaultModel,
    sendMessage,
    getSystemPrompt,
} from './platform-factory';

// Platform classes (for direct use if needed)
export { GeminiPlatform } from './platforms/gemini-platform';
export { OpenAIPlatform } from './platforms/openai-platform';
export { DeepSeekPlatform } from './platforms/deepseek-platform';
export { GrokPlatform } from './platforms/grok-platform';
