/**
 * Long chain of thought → one compact link message.
 *
 * A CoT that already fills a whole Telegram message used to be split into
 * several quote-stuffed messages. The reply now opens with one message whose
 * visible text is a single link (opens the Mini App thinking page) and whose
 * link preview opens the faster plain SSR page — the same two-entry split as
 * the widget fallback (text_link → Mini App, link_preview_options → fast page).
 *
 * Construction only: the streaming state machine decides when to switch.
 */
import { concatMessages } from 'telegram-md-entities';
import type { RenderedMessage } from 'telegram-md-entities';
import type { LinkPreviewOptions } from '../link-preview.js';
import type { FinalMessageChunk } from './final-message-builder.js';
import type { ThinkingLinkRef } from '../../panel/thinking/thinking-link-service.js';

/** The thinking-link contract lives with its service (design §8.1); re-exported here */
export type { ThinkingLinkRef };

/** The whole visible text of the link message (the emoji is part of the link) */
export const THINKING_LINK_LABEL = '🧠 查看完整思考过程';

/**
 * Preview card of the link message: the fast page, shown below the text. No
 * large media — the page has no og:image, so Telegram renders a text card.
 */
export const thinkingLinkPreviewOptions = (ref: ThinkingLinkRef): LinkPreviewOptions => ({
    url: ref.fastPageUrl,
    show_above_text: false,
});

/** Terminal link message: the entire visible text is the Mini App link */
export const renderThinkingLinkMessage = (ref: ThinkingLinkRef): RenderedMessage => ({
    text: THINKING_LINK_LABEL,
    entities: [
        {
            type: 'text_link',
            offset: 0,
            length: THINKING_LINK_LABEL.length,
            url: ref.miniAppUrl,
        },
    ],
});

/**
 * Streaming link message: the link, a blank line, then the caller-rendered
 * thinking preview (a bare blockquote — see formatThinkingPreviewForLink), so
 * the message height stays stable while the CoT grows.
 */
export const renderThinkingLinkStreaming = (
    ref: ThinkingLinkRef,
    preview: RenderedMessage
): RenderedMessage =>
    preview.text
        ? concatMessages(renderThinkingLinkMessage(ref), '\n\n', preview)
        : renderThinkingLinkMessage(ref);

/** Terminal chunk for buildFinalMessages / version replay, preview card included */
export const toThinkingLinkChunk = (ref: ThinkingLinkRef): FinalMessageChunk => ({
    ...renderThinkingLinkMessage(ref),
    linkPreviewOptions: thinkingLinkPreviewOptions(ref),
});
