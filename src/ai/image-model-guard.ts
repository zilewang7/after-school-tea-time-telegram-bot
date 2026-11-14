/**
 * An image model serves generate_image and the /pic commands only. Those send
 * neither a system prompt nor tools, while every chat reply carries a system
 * prompt; so a request with either is a chat reply and is refused. Without
 * this, OpenAI's image path would quietly turn the whole conversation into one
 * image prompt.
 */
import type { PlatformConfig } from './types.js';

export const isChatShapedRequest = (config: PlatformConfig): boolean =>
    config.systemPrompt !== undefined || config.tools !== undefined;

export const imageModelChatError = (model: string): Error =>
    new Error(`${model} is an image model: it serves generate_image and the /pic commands, never a chat reply`);
