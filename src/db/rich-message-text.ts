/**
 * The blocks of a rich message users send (Bot API 10.1+) → the markdown
 * stored for the context tree.
 *
 * They are JSON the server keeps extending. telegram-md-entities renders the
 * shapes it does not know as their text; should it still throw on one, the
 * plain text is stored instead, so no Bot API change can drop a message.
 */
import type { RichBlock, RichMessage } from 'grammy/types';
import { richBlocksToMarkdown } from 'telegram-md-entities';
import { richBlocksPlainText } from './rich-plain-text.js';

/** Rich blocks → markdown; injectable so the offline cases can make it throw */
export type RichBlocksRenderer = (blocks: RichBlock[]) => string;

/** The rendered markdown, or the plain text when the renderer throws */
const renderedOrPlainText = (
    render: () => string,
    plainText: () => string,
    subject: string
): string => {
    try {
        return render();
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`[autoSave] ${subject} could not be rendered, stored as plain text: ${reason}`);
        return plainText();
    }
};

const nonEmpty = (text: string): string | undefined => {
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

/** Rich messages (Premium rich text editor, Bot API 10.1+) → markdown */
export const renderRichMessage = (
    richMessage: RichMessage | undefined,
    messageKey: string,
    renderBlocks: RichBlocksRenderer = richBlocksToMarkdown
): string | undefined => {
    if (!richMessage) return undefined;
    const { blocks } = richMessage;
    return nonEmpty(renderedOrPlainText(
        () => renderBlocks(blocks),
        () => richBlocksPlainText(blocks),
        `rich message ${messageKey}`
    ));
};
