/**
 * Reply module exports
 */

// Main loader
export { replyLoad } from './loader';

// Chat handler
export { handleReply, reply, registerChatHandler } from './chat-handler';

// Picbanana handler
export {
    handlePicbananaCommand,
    checkPicbananaCommand,
    type PicbananaCommandData,
} from './picbanana-handler';

// Context builder
export { buildContext, buildSimpleContext, buildContextFromParts } from './context-builder';

// Response handler
export {
    createChatContext,
    processStream,
    sendFinalResponse,
    handleResponseError,
    type ChatContext,
} from './response-handler';

// Commands
export { dealChatCommand } from './commands/chat-command';

// Re-export for backward compatibility with old imports
export { getRepliesHistory, getFileContentsOfMessage } from '../db/queries/context-queries';
