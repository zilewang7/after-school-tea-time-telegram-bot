/**
 * Everything the tools of one reply remember between their calls: the media
 * ids and attachment flags, the `hN` history numbering, the harness issue
 * count and the workspace tokens and call counters.
 *
 * createReplyTools makes one bundle per reply. A continued reply is handed the
 * bundle of the version it continues, so `g1` still resolves and the per-reply
 * limits go on counting instead of starting over (design 2026-1112-1123 §6.2).
 */
import { getToolConfig, type ToolConfig } from '../../config/tool-config.js';
import { createHarnessIssueState, type HarnessIssueState } from './harness-issue-state.js';
import { createHistoryState, type HistoryState } from './history-state.js';
import { createReplyMediaState, type ReplyMediaState } from './reply-media-state.js';
import {
    createWorkspaceState,
    WORKSPACE_CALL_LIMITS,
    type WorkspaceState,
} from '../workspace/workspace-state.js';

export interface ReplyToolState {
    readonly media: ReplyMediaState;
    readonly history: HistoryState;
    readonly harnessIssues: HarnessIssueState;
    readonly workspace: WorkspaceState;
}

export interface ReplyToolStateInput {
    readonly chatId: number;
    /** Reply-tree roots of the context, the trigger's own conversation first */
    readonly conversationRootIds: readonly number[];
}

/** A fresh bundle for a reply that starts from nothing */
export const createReplyToolState = (
    input: ReplyToolStateInput,
    config: ToolConfig = getToolConfig()
): ReplyToolState => ({
    media: createReplyMediaState(),
    history: createHistoryState(),
    harnessIssues: createHarnessIssueState(),
    workspace: createWorkspaceState({
        chatId: input.chatId,
        conversationRootIds: input.conversationRootIds,
        quota: {
            maxFileBytes: config.workspaceMaxFileBytes,
            maxConversationBytes: config.workspaceMaxConversationBytes,
            maxFiles: config.workspaceMaxFiles,
            maxGlobalBytes: config.workspaceMaxGlobalBytes,
        },
        callLimits: { ...WORKSPACE_CALL_LIMITS, previews: config.workspacePreviewsPerReply },
    }),
});
