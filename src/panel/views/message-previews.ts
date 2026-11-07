/**
 * The link previews a member sees on a user message of the tree: the text the
 * model reads for the message's first URL (luoxu link preview) and for its
 * pasted t.me message links (cached snapshots or our own rows), planned with
 * the same newest-first budget as the reply path. Text only — no media bytes
 * are read — and never fetched: both sources only read caches.
 */
import type { ContextMessage } from '../../db/queries/context-queries.js';
import type { ContextNumbering } from '../../reply/context-assembly.js';
import { getLinkPreviewParts } from '../../services/luoxu-preview-service.js';
import {
    getTgMessageLinkPreviewParts,
    planTgMessageLinkPreviews,
} from '../../services/tg-message-link-service.js';
import type { UnifiedContentPart } from '../../ai/types.js';

const textsOf = (parts: readonly UnifiedContentPart[]): string[] =>
    parts.flatMap((part) => (part.type === 'text' && part.text ? [part.text] : []));

/** messageId → preview text, for the user messages of the context that have one */
export const buildLinkPreviewTexts = async (
    chatId: number,
    contextMessages: readonly ContextMessage[],
    numbering: ContextNumbering,
    chatTitle: string | null
): Promise<Map<number, string>> => {
    const userMessages = contextMessages.filter((message) => !message.fromBotSelf);
    const plan = planTgMessageLinkPreviews(
        chatId,
        userMessages.map((message) => ({ messageId: message.messageId, text: message.text })),
        { maxWithMedia: 0 }
    );

    const previews = new Map<number, string>();
    for (const message of userMessages) {
        const linkPreview = await getLinkPreviewParts(message.text, { withMedia: false });
        const messageLinks = await getTgMessageLinkPreviewParts(
            chatId,
            plan.get(message.messageId),
            numbering.numberOf,
            { chatTitle }
        );
        const texts = [...textsOf(linkPreview), ...textsOf(messageLinks)];
        if (texts.length > 0) previews.set(message.messageId, texts.join('\n\n'));
    }
    return previews;
};
