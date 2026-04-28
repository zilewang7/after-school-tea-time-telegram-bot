/**
 * Reply module exports
 */

// Main loader
export { replyLoad } from './loader.js';

// Chat handler
export { handleReply, reply, registerChatHandler } from './chat-handler.js';

// Context builder
export { buildContext, buildSimpleContext, buildContextFromParts } from './context-builder.js';

// Response handler
export {
    createChatContext,
    processStream,
    sendFinalResponse,
    handleResponseError,
    type ChatContext,
} from './response-handler.js';

// Commands
export { dealChatCommand } from './commands/chat-command.js';

// Picbanana handler
export {
    handlePicbananaCommand,
    checkPicbananaCommand,
    type PicbananaCommandData,
} from './commands/picbanana-handler.js';

// Re-export for backward compatibility with old imports
export { getRepliesHistory, getFileContentsOfMessage } from '../db/queries/context-queries.js';
