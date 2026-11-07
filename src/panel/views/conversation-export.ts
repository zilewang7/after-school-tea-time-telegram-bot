/**
 * GET …/conversations/:rootId/export: one conversation as a file, members
 * only. Holds the export time, the tree in the member view, every version of
 * every bot reply in it (text, thinking, tool records, errors) and the model
 * view (static head with the preference layer, every turn) — never base64,
 * never modelParts. Read-only: nothing is audited.
 *
 * The model view is recomputed like the model-view endpoint; when the
 * conversation has nothing to recompute from, the export still goes out with
 * the reason in place of it.
 */
import type { ChatRow } from '../../db/queries/panel-registry.js';
import { listBotResponsesByIds } from '../../db/queries/context-queries.js';
import type { Api } from 'grammy';
import { PanelError } from '../errors.js';
import { buildConversationTreeView, type ConversationTreeView } from './conversation-tree.js';
import { renderConversationMarkdown } from './conversation-markdown.js';
import { buildModelView, type ModelView } from './model-view.js';
import { buildReplyDetailView, type ReplyDetailView } from './reply-view.js';

export type ExportFormat = 'md' | 'json';

export interface ConversationExport {
    exportedAt: string;
    chat: { chatId: number; type: string; title: string | null; username: string | null };
    rootId: number;
    tree: ConversationTreeView;
    replies: ReplyDetailView[];
    modelView: ModelView | null;
    /** Why there is no model view; null when there is one */
    modelViewUnavailable: string | null;
}

export interface RenderedExport {
    body: string;
    contentType: string;
    fileName: string;
}

const buildModelViewOrReason = async (
    chat: ChatRow,
    rootId: number,
    toolApi: Api,
    now: Date
): Promise<{ modelView: ModelView | null; reason: string | null }> => {
    try {
        return { modelView: await buildModelView({ chat, rootId, at: undefined, asModel: undefined, toolApi, now }), reason: null };
    } catch (error) {
        if (error instanceof PanelError && error.status < 500) return { modelView: null, reason: error.message };
        throw error;
    }
};

export const buildConversationExport = async (options: {
    chat: ChatRow;
    rootId: number;
    toolApi: Api;
    now: Date;
}): Promise<ConversationExport> => {
    const { chat, rootId, now } = options;
    const tree = await buildConversationTreeView(chat, 'member', rootId);
    const botIds = tree.nodes.filter((node) => node.kind === 'bot').map((node) => node.messageId);
    const replies: ReplyDetailView[] = [];
    for (const response of await listBotResponsesByIds(chat.chatId, botIds)) {
        replies.push(await buildReplyDetailView(response, 'member'));
    }
    const { modelView, reason } = await buildModelViewOrReason(chat, rootId, options.toolApi, now);
    return {
        exportedAt: now.toISOString(),
        chat: { chatId: chat.chatId, type: chat.type, title: chat.title, username: chat.username },
        rootId,
        tree,
        replies,
        modelView,
        modelViewUnavailable: reason,
    };
};

export const renderConversationExport = (exported: ConversationExport, format: ExportFormat): RenderedExport => {
    const baseName = `conversation_${exported.chat.chatId}_${exported.rootId}`;
    return format === 'json'
        ? {
              body: JSON.stringify(exported, null, 2),
              contentType: 'application/json; charset=utf-8',
              fileName: `${baseName}.json`,
          }
        : {
              body: renderConversationMarkdown(exported),
              contentType: 'text/markdown; charset=utf-8',
              fileName: `${baseName}.md`,
          };
};
