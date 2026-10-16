/**
 * System prompt module - layered prompt assembly
 */

export { buildStaticSystemPrompt, type StaticPromptOptions } from './builder.js';
export { buildRuntimeContext } from './runtime-context.js';
export { getPreferencePrompt } from './preference.js';
