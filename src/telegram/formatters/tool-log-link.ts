/**
 * The compact message a Tools block becomes when it cannot fit one Telegram
 * message (design 2026-1119-1835 §13.1), the same shape as the folded
 * GoogleSearch footer (google-search-link.ts): one text link to the public log
 * page, the usage line the block would have shown as its front row, and the
 * page's preview card.
 *
 * The visible text stays the link, so the chat shows a compact pointer instead
 * of a chain of quote-block fragments; the page holds every call.
 */
import { concatMessages } from 'telegram-md-entities';
import type { RenderedMessage } from 'telegram-md-entities';
import type { ToolLogPageLink } from '../../shared/tool-log-page.js';
import type { LinkPreviewOptions } from '../link-preview.js';
import { italicText } from './entity-text.js';
import type { ToolLogDocument } from './tool-log-document.js';
import type { FinalMessageChunk } from './final-message-builder.js';

/** The whole visible text of the link (the emoji is part of the link) */
export const TOOL_LOG_LINK_LABEL = '🔧 查看完整工具调用';

/**
 * The line under the link: the usage front line the block would have shown,
 * which keeps the owner's `tool usage: 工具名 x次数 | …` display in the folded
 * case too. Falls back to a plain count line when there is no usage line.
 */
export const toolLogLinkSummaryLine = (document: ToolLogDocument): string =>
    document.usageLine !== ''
        ? document.usageLine
        : `共 ${document.totalCalls.toLocaleString('zh-CN')} 次调用`;

/**
 * The card of the link message: the public log page, shown below the text. The
 * page has no og:image, so Telegram renders a text card whose title and
 * description the page itself sets.
 */
export const toolLogLinkPreviewOptions = (link: ToolLogPageLink): LinkPreviewOptions => ({
    url: link.url,
    show_above_text: false,
});

/** Terminal message: the link, then the usage line on the very next line */
export const renderToolLogLinkMessage = (
    link: ToolLogPageLink,
    document: ToolLogDocument
): RenderedMessage => {
    const label: RenderedMessage = {
        text: TOOL_LOG_LINK_LABEL,
        entities: [
            {
                type: 'text_link',
                offset: 0,
                length: TOOL_LOG_LINK_LABEL.length,
                url: link.url,
            },
        ],
    };
    return concatMessages(label, '\n', italicText(toolLogLinkSummaryLine(document)));
};

/** Terminal chunk for buildFinalMessages / version replay, preview card included */
export const toToolLogLinkChunk = (
    link: ToolLogPageLink,
    document: ToolLogDocument
): FinalMessageChunk => ({
    ...renderToolLogLinkMessage(link, document),
    linkPreviewOptions: toolLogLinkPreviewOptions(link),
    part: 'tools-link',
});
