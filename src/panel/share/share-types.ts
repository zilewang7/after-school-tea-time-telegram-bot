/**
 * The share feature's shapes (design §5.6/§6.1): what the panel API returns,
 * what a row stores, and the reasons a create request can be refused.
 *
 * A share is public: anyone with the token can read the page, so nothing here
 * carries base64 media. The one image a page needs is served by its own route
 * (`/s/<token>/og.png`, `/s/<token>/media/…`).
 */

export type ShareKind = 'reply' | 'conversation';

/** Who created the row: a panel user, or the bot's group link fallback */
export type ShareSource = 'user' | 'system';

/** What a stored preview image came from; new rows only store 'widget' (rows keep old values) */
export type PreviewSource = 'widget' | 'image' | 'text' | 'raw-widget';

/** A share link as the panel API shows it (the record contract of design §5.6) */
export interface ShareLinkRecord {
    token: string;
    /** Absolute public URL (WEBAPP_PUBLIC_URL + /s/<token>) */
    url: string;
    kind: ShareKind;
    chatId: number;
    firstMessageId: number | null;
    rootId: number | null;
    versionId: number | null;
    /** 0 = the system (group link fallback) */
    createdBy: number;
    source: ShareSource;
    /** ISO time */
    createdAt: string;
    /** ISO time; null while the link is active */
    revokedAt: string | null;
    viewCount: number;
    previewWidth: number | null;
    previewHeight: number | null;
}

/** A share link plus what this requester may do with it */
export interface ShareLinkView extends ShareLinkRecord {
    canRevoke: boolean;
}

/** A full share_links row, including the preview bytes only the server reads */
export interface ShareRow {
    id: number;
    token: string;
    kind: ShareKind;
    chatId: number;
    firstMessageId: number | null;
    rootId: number | null;
    versionId: number | null;
    createdBy: number;
    source: ShareSource;
    createdAt: string;
    revokedAt: string | null;
    previewImageBase64: string | null;
    previewWidth: number | null;
    previewHeight: number | null;
    previewSource: PreviewSource | null;
    viewCount: number;
    lastViewedAt: string | null;
}

/** What a create request names: exactly one of the two targets */
export type ShareTarget =
    | { kind: 'reply'; chatId: number; firstMessageId: number; versionId: number | null }
    | { kind: 'conversation'; chatId: number; rootId: number };

/** Why a user share could not be created; the route maps these to statuses */
export const SHARE_CREATE_FAILURES = {
    invalidTarget: 'invalid_target',
    replyNotFound: 'reply_not_found',
    versionNotFound: 'version_not_found',
    conversationNotFound: 'conversation_not_found',
} as const;

export type ShareCreateFailure = (typeof SHARE_CREATE_FAILURES)[keyof typeof SHARE_CREATE_FAILURES];

/** What a share's preview image is rendered from: only `widgetHtml` draws one */
export interface PreviewSnapshot {
    /** Group title; not part of the image any more (kept for older stored cards) */
    chatTitle: string | null;
    /** ISO time of the shared content */
    createdAt: string;
    /** Plain text of the reply (or of the conversation's newest bot reply) */
    text: string;
    /** Final widget HTML; the only field that produces a preview image */
    widgetHtml?: string;
    /** 600px rendered widget PNG (base64); older stored cards used it, never the render */
    widgetImageBase64?: string;
    /** Widget caption; not part of the image */
    caption?: string | null;
    /** Image attachment bytes (base64); not part of the image */
    imageBase64?: string;
}

/** A rendered preview image, ready to store */
export interface PreviewImage {
    base64: string;
    width: number;
    height: number;
    source: PreviewSource;
}
