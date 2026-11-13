/**
 * The volatile tail of the trigger message: the workspace manifest, then the
 * handoff note when this chat may read one. Both ride after the runtime block;
 * neither touches the byte-stable static prompt.
 *
 * One entry point for the three context builders (reply, retry, panel model
 * view) keeps the tail identical across them: a retry and the panel must show
 * the same volatile tail as the first answer.
 */
import type { AppendWorkspaceManifestInput } from './workspace-manifest.js';
import { appendWorkspaceManifestForReply } from './workspace-manifest.js';
import { appendWorkspaceHandoff, buildHandoffSection } from './workspace-handoff.js';
import { CURRENT_WORKSPACE_TOKEN } from './workspace-state.js';

export interface AppendWorkspaceTailForReplyInput extends AppendWorkspaceManifestInput {
    /** The handoff tool is offered this turn: inject the note too */
    readonly handoff: boolean;
}

/**
 * Build and append the volatile tail. Each part fails closed: an injection
 * failure never breaks a reply.
 */
export const appendWorkspaceTailForReply = async (input: AppendWorkspaceTailForReplyInput): Promise<void> => {
    await appendWorkspaceManifestForReply(input);
    if (!input.handoff) return;
    try {
        const current = input.workspaceState.refs.get(CURRENT_WORKSPACE_TOKEN);
        if (current === undefined) return;
        const section = await buildHandoffSection({
            chatId: input.workspaceState.chatId,
            conversationRootId: current.rootId,
        });
        if (section !== null) appendWorkspaceHandoff(input.messages, input.triggerTurnIndex, section);
    } catch (error) {
        console.warn('[workspace] handoff injection failed:', error);
    }
};
