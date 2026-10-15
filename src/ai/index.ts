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
} from './platform-factory.js';

// System prompt (static head + per-request runtime block)
export {
    buildStaticSystemPrompt,
    buildRuntimeContext,
    getPreferencePrompt,
} from './system-prompt/index.js';

// Platform classes (for direct use if needed)
export { GeminiPlatform } from './platforms/gemini-platform.js';
export { OpenAIPlatform } from './platforms/openai-platform.js';
export { DeepSeekPlatform } from './platforms/deepseek-platform.js';
export { GrokPlatform } from './platforms/grok-platform.js';
export { MimoPlatform } from './platforms/mimo-platform.js';

// OpenCode Go route helpers (Argon only; see opencode-go-fetch.ts)
export {
    isOpenCodeGoModel,
    openCodeGoSessionId,
    parseModelMap,
} from './platforms/opencode-go-fetch.js';
