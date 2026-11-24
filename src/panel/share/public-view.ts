/**
 * The public view of a share, free of HTTP: the JSON form the Mini App reads
 * and the model block of the reply context are both built from this.
 *
 * It lives outside `public-api.ts` so a reply-layer caller (the context
 * builder) can import it without pulling Hono routes in. Widget HTML and media
 * bytes are not part of the view: the webapp frames `/s/<token>/widget/<i>` and
 * loads `/s/<token>/media/<messageId>/<slot>` instead. The server-side
 * `preview` snapshot (base64 card input) never leaves this module either.
 */
import {
    type ShareBubble,
    type ShareContent,
    type ShareConversationContent,
    type ShareMedia,
    type ShareMediaItem,
    type ShareReplyContent,
    type ShareReplyTarget,
    type ShareWidgetContent,
} from './share-content.js';
import type { ShareReactionPill } from './share-reactions.js';
import type { ShareRow } from './share-types.js';

/** A widget's public facts; the HTML itself is served by its own route */
export interface PublicShareWidgetView {
    caption: string | null;
}

/** One attachment of the shared content; the bytes come from the share's media route */
export interface PublicShareMediaView {
    kind: 'image' | 'video' | 'audio' | 'sticker' | 'file';
    mimeType: string;
    sizeBytes: number | null;
    /** Download name for documents */
    fileName: string | null;
    /**
     * The picture's caption, when the version stored one: the Mini App renders
     * it under the picture in a rich body. Absent otherwise.
     */
    caption?: string | null;
    /** Where the version delivered the picture; absent for non-version media */
    placement?: 'inline' | 'attachment';
    /** Inline only: the media id the answer snapshot's block references (`img1`) */
    id?: string | null;
}

/** One attachment of a share bubble: the message whose file it is */
export interface PublicShareMediaItemView extends PublicShareMediaView {
    /** A media group item has its own message id; its bytes come from that one */
    messageId: number;
    /**
     * 0-based picture position inside that message's media list (v5 several
     * pictures per reply); absent for the first / only picture
     */
    index?: number;
}

/** One reaction pill: the public page shows counts, never the people behind them */
export interface PublicShareReactionView {
    emoji: string;
    count: number;
}

export interface PublicShareReplyView {
    firstMessageId: number;
    versionId: number;
    versionNumber: number;
    createdAt: string;
    model: string | null;
    text: string;
    /**
     * The pinned version's rendered answer body when it delivered a rich body
     * with the v1 renderer: the Mini App lays the pictures out in place.
     */
    richAnswerMarkdown?: string;
    widget: PublicShareWidgetView | null;
    /** The pinned version's pictures in delivery order (empty when it has none) */
    media: PublicShareMediaView[];
    /** Reactions on the reply, as emoji + count */
    reactions: PublicShareReactionView[];
}

/** The message a bubble answers, when it is part of the shared conversation */
export interface PublicShareReplyTargetView {
    messageId: number;
    authorName: string;
    snippet: string | null;
    mediaHint: string | null;
}

export interface PublicShareBubbleView {
    kind: 'user' | 'bot';
    messageId: number;
    createdAt: string;
    /** Telegram no longer has the message; the Mini App folds it by default */
    deleted: boolean;
    /** User bubbles only */
    authorName?: string;
    text: string;
    /** Bot bubbles only: the current version's rendered answer body */
    richAnswerMarkdown?: string;
    /** User bubbles only: the part of another message this one quotes */
    quote?: string | null;
    /** User bubbles only: readable text of the captured web preview */
    previewText?: string | null;
    /** User bubbles only; bot bubbles carry `null` */
    mediaHint: string | null;
    widget: PublicShareWidgetView | null;
    /** Every attachment of the bubble in display order (empty when none) */
    media: PublicShareMediaItemView[];
    /** Link-preview pictures / clips captured for the bubble's first URL */
    previewMedia: PublicShareMediaView[];
    /** The bubble this one answers; null when it is outside the share */
    replyTo: PublicShareReplyTargetView | null;
    /** Reactions on the message, as emoji + count */
    reactions: PublicShareReactionView[];
    /** Bot bubbles only: the model of the version on screen; null when it is unknown */
    model?: string | null;
}

export interface PublicShareConversationView {
    rootId: number;
    bubbles: PublicShareBubbleView[];
}

/** One share as the Mini App sees it; `reply` or `conversation` is present, never both */
export interface PublicShareView {
    token: string;
    kind: 'reply' | 'conversation';
    chatId: number;
    chatTitle: string | null;
    /** ISO time the share was created */
    createdAt: string;
    reply?: PublicShareReplyView;
    conversation?: PublicShareConversationView;
}

const widgetViewOf = (widget: ShareWidgetContent | null): PublicShareWidgetView | null =>
    widget === null ? null : { caption: widget.caption };

const mediaFieldsOf = (media: ShareMedia): PublicShareMediaView => ({
    kind: media.kind,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    fileName: media.fileName,
    // Only what the descriptor really carries: a null placeholder would make
    // every user-message attachment look like a version picture
    ...(typeof media.caption === 'string' ? { caption: media.caption } : {}),
    ...(media.placement === undefined ? {} : { placement: media.placement }),
    ...(typeof media.id === 'string' ? { id: media.id } : {}),
});

/** The single attachment forms (a reply's version, a link preview) */
const mediaViewOf = (media: ShareMedia | null): PublicShareMediaView | null =>
    media === null ? null : mediaFieldsOf(media);

/** A bubble attachment, which also names the message its bytes belong to */
const mediaItemViewOf = (item: ShareMediaItem): PublicShareMediaItemView => ({
    messageId: item.messageId,
    ...(item.index === undefined || item.index === 0 ? {} : { index: item.index }),
    ...mediaFieldsOf(item),
});

const reactionsViewOf = (pills: readonly ShareReactionPill[]): PublicShareReactionView[] =>
    pills.map((pill) => ({ emoji: pill.emoji, count: pill.count }));

const replyViewOf = (content: ShareReplyContent): PublicShareReplyView => ({
    firstMessageId: content.firstMessageId,
    versionId: content.versionId,
    versionNumber: content.versionNumber,
    createdAt: content.createdAt,
    model: content.model,
    text: content.text,
    ...(content.richAnswerMarkdown === undefined ? {} : { richAnswerMarkdown: content.richAnswerMarkdown }),
    widget: widgetViewOf(content.widget),
    media: content.media.map(mediaFieldsOf),
    reactions: reactionsViewOf(content.reactions),
});

const replyTargetViewOf = (target: ShareReplyTarget | null): PublicShareReplyTargetView | null =>
    target === null
        ? null
        : {
              messageId: target.messageId,
              authorName: target.authorName,
              snippet: target.snippet,
              mediaHint: target.mediaHint,
          };

const bubbleViewOf = (bubble: ShareBubble): PublicShareBubbleView => {
    if (bubble.kind === 'user') {
        return {
            kind: 'user',
            messageId: bubble.messageId,
            createdAt: bubble.createdAt,
            deleted: bubble.deleted,
            authorName: bubble.authorName,
            text: bubble.text,
            quote: bubble.quote,
            previewText: bubble.previewText,
            mediaHint: bubble.mediaHint,
            widget: null,
            media: bubble.media.map(mediaItemViewOf),
            previewMedia: bubble.previewMedia.flatMap((preview) => {
                const view = mediaViewOf(preview);
                return view === null ? [] : [view];
            }),
            replyTo: replyTargetViewOf(bubble.replyTo),
            reactions: reactionsViewOf(bubble.reactions),
        };
    }
    return {
        kind: 'bot',
        messageId: bubble.messageId,
        createdAt: bubble.createdAt,
        deleted: bubble.deleted,
        text: bubble.text,
        ...(bubble.richAnswerMarkdown === undefined ? {} : { richAnswerMarkdown: bubble.richAnswerMarkdown }),
        mediaHint: null,
        widget: widgetViewOf(bubble.widget),
        media: bubble.media.map(mediaItemViewOf),
        previewMedia: [],
        replyTo: replyTargetViewOf(bubble.replyTo),
        reactions: reactionsViewOf(bubble.reactions),
        model: bubble.model,
    };
};

const conversationViewOf = (content: ShareConversationContent): PublicShareConversationView => ({
    rootId: content.rootId,
    bubbles: content.bubbles.map(bubbleViewOf),
});

/** The public view of one loaded share; `preview` and widget HTML are dropped */
export const toPublicShareView = (row: ShareRow, content: ShareContent): PublicShareView => ({
    token: row.token,
    kind: content.kind,
    chatId: content.chatId,
    chatTitle: content.chatTitle,
    createdAt: row.createdAt,
    ...(content.kind === 'reply'
        ? { reply: replyViewOf(content) }
        : { conversation: conversationViewOf(content) }),
});
