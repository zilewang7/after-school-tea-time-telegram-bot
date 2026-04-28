/**
 * AI module - unified AI platform interface
 */

// Types
export * from './types.js';

// Message transformer
export * from './message-transformer.js';

// MCP module
export * from './mcp/index.js';

// Platform factory
export {
    getPlatform,
    getModelCapabilities,
    isImageModel,
    getDefaultModel,
    sendMessage,
    getSystemPrompt,
} from './platform-factory.js';

// Platform classes (for direct use if needed)
export { GeminiPlatform } from './platforms/gemini-platform.js';
export { OpenAIPlatform } from './platforms/openai-platform.js';
export { DeepSeekPlatform } from './platforms/deepseek-platform.js';
export { GrokPlatform } from './platforms/grok-platform.js';
export { MimoPlatform } from './platforms/mimo-platform.js';
