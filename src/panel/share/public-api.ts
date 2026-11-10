/**
 * The public JSON form of a share (design §5.6/§5.7): what the Mini App reads
 * when it opens `?startapp=s<token>`.
 *
 * No initData, no cookies — the token is the permission, exactly like the SSR
 * page. The view is deliberately small: widget HTML and media bytes are not
 * part of it; the webapp frames `/s/<token>/widget/<i>` and loads
 * `/s/<token>/media/<messageId>/<slot>` instead. The server-side `preview`
 * snapshot (base64 card input) never leaves this process.
 *
 * Every failure — disabled feature, malformed, unknown or revoked token — is
 * the same 404 JSON, so a caller cannot tell whether a token ever existed.
 */
import type { Context, Hono } from 'hono';
import type { PanelEnv } from '../context.js';
import { errorBody, PANEL_MESSAGES } from '../errors.js';
import { clientIpOf, createPublicRateLimiter, PUBLIC_RATE_LIMIT } from './public-routes.js';
import { loadPublicShare } from './share-link-service.js';
import {
    type ShareBubble,
    type ShareContent,
    type ShareConversationContent,
    type ShareMedia,
    type ShareReplyContent,
    type ShareWidgetContent,
} from './share-content.js';
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
}

export interface PublicShareReplyView {
    firstMessageId: number;
    versionId: number;
    versionNumber: number;
    createdAt: string;
    model: string | null;
    text: string;
    widget: PublicShareWidgetView | null;
    media: PublicShareMediaView | null;
}

export interface PublicShareBubbleView {
    kind: 'user' | 'bot';
    messageId: number;
    createdAt: string;
    /** User bubbles only */
    authorName?: string;
    text: string;
    /** User bubbles only; bot bubbles carry `null` */
    mediaHint: string | null;
    widget: PublicShareWidgetView | null;
    /** The bubble's attachment, when the retention still has it */
    media: PublicShareMediaView | null;
    /** Link-preview pictures / clips captured for the bubble's first URL */
    previewMedia: PublicShareMediaView[];
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

const mediaViewOf = (media: ShareMedia | null): PublicShareMediaView | null =>
    media === null
        ? null
        : { kind: media.kind, mimeType: media.mimeType, sizeBytes: media.sizeBytes, fileName: media.fileName };

const replyViewOf = (content: ShareReplyContent): PublicShareReplyView => ({
    firstMessageId: content.firstMessageId,
    versionId: content.versionId,
    versionNumber: content.versionNumber,
    createdAt: content.createdAt,
    model: content.model,
    text: content.text,
    widget: widgetViewOf(content.widget),
    media: mediaViewOf(content.media),
});

const bubbleViewOf = (bubble: ShareBubble): PublicShareBubbleView => {
    if (bubble.kind === 'user') {
        return {
            kind: 'user',
            messageId: bubble.messageId,
            createdAt: bubble.createdAt,
            authorName: bubble.authorName,
            text: bubble.text,
            mediaHint: bubble.mediaHint,
            widget: null,
            media: mediaViewOf(bubble.media),
            previewMedia: bubble.previewMedia.flatMap((preview) => {
                const view = mediaViewOf(preview);
                return view === null ? [] : [view];
            }),
        };
    }
    return {
        kind: 'bot',
        messageId: bubble.messageId,
        createdAt: bubble.createdAt,
        text: bubble.text,
        mediaHint: null,
        widget: widgetViewOf(bubble.widget),
        media: mediaViewOf(bubble.media),
        previewMedia: [],
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

/** Same message for every 404: a caller learns nothing about a token */
const SHARE_NOT_FOUND_MESSAGE = '分享不存在或已撤销';

const NOINDEX = 'noindex, nofollow';
const NO_STORE = 'no-store';

const notFoundResponse = (context: Context<PanelEnv>): Response =>
    context.json(errorBody('not_found', SHARE_NOT_FOUND_MESSAGE), 404, {
        'Cache-Control': NO_STORE,
        'X-Robots-Tag': NOINDEX,
    });

const rateLimitedResponse = (context: Context<PanelEnv>): Response =>
    context.json(errorBody('rate_limited', PANEL_MESSAGES.rateLimited), 429, {
        'Cache-Control': NO_STORE,
        'Retry-After': '60',
        'X-Robots-Tag': NOINDEX,
    });

export interface PublicShareApiOptions {
    /** SHARE_ENABLED is not 0; off answers the same 404 as an unknown token */
    enabled: boolean;
    now?: () => number;
    rateLimit?: { limit: number; windowMs: number };
}

/**
 * `GET /api/public/shares/<token>`. Registered in front of the /api middleware
 * stack (no initData, no per-user rate limit); the per-IP limiter is the public
 * one the `/s/*` routes use.
 */
export const registerPublicShareApiRoutes = (app: Hono<PanelEnv>, options: PublicShareApiOptions): void => {
    const now = options.now ?? Date.now;
    const allow = createPublicRateLimiter({ ...(options.rateLimit ?? PUBLIC_RATE_LIMIT), now });

    app.get('/api/public/shares/:token', async (context) => {
        if (!options.enabled) return notFoundResponse(context);
        if (!allow(clientIpOf(context))) return rateLimitedResponse(context);
        const share = await loadPublicShare(context.req.param('token'));
        if (share === null) return notFoundResponse(context);
        return context.json({ share: toPublicShareView(share.row, share.content) }, 200, {
            'Cache-Control': NO_STORE,
            'X-Robots-Tag': NOINDEX,
        });
    });
};
