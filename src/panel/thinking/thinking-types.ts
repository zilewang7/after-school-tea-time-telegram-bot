/**
 * Types of the long-thinking view (design §5): the stored link row, the live
 * in-memory stream entry, the page document and the public API response.
 *
 * Only `ThinkingLinkRef` leaves this module boundary — it is what the bot renders
 * into the link message (design §7). Everything else is read by the two public
 * entries and the page renderer here.
 */

/** The two entries the bot points its message at */
export interface ThinkingLinkRef {
    token: string;
    /** Mini App Direct Link; the message's visible text links here */
    miniAppUrl: string;
    /** Plain SSR page; the link preview opens here */
    fastPageUrl: string;
}

/** One row of the raw `thinking_links` table (design §5.1) */
export interface ThinkingLinkRow {
    token: string;
    chatId: number;
    firstMessageId: number;
    /** 1-based version id, the same value as `ResponseVersion.versionId` */
    versionId: number;
    model: string | null;
    /** ISO timestamp */
    createdAt: string;
}

/** Creating (or reusing) the link of one reply version */
export interface BeginThinkingLinkInput {
    chatId: number;
    firstMessageId: number;
    versionId: number;
    model: string;
}

/** The attempt a live stream entry belongs to; it is known before any token exists */
export interface ThinkingAttemptInput {
    chatId: number;
    firstMessageId: number;
    versionId: number;
}

/** The live thinking of one attempt (in memory only; design §5.2) */
export interface ThinkingStreamEntry {
    text: string;
    /** The 200k-character cap was hit; `text` ends with the truncation mark */
    truncated: boolean;
    done: boolean;
    /** ms epoch of `finish`; null while generating */
    finishedAt: number | null;
    /** ms epoch of the last append / finish */
    updatedAt: number;
}

/** How the page and the API describe the thinking stream (design §5.4) */
export type ThinkingStatus = 'generating' | 'done' | 'interrupted' | 'unavailable';

/** What `GET /api/public/thinking/<token>` answers */
export interface PublicThinkingResponse {
    token: string;
    model: string | null;
    /** ISO timestamp of the link, not of the reference */
    createdAt: string;
    /** The thinking stream has ended */
    done: boolean;
    status: ThinkingStatus;
    /** The version's error line (stopped / failed) when it has one */
    errorMessage: string | null;
    /** Full text, only when the request carries no `after` */
    text: string;
    /** Increment, only when the request carries an in-range `after` */
    delta?: string;
    /** The `after` to poll with next time */
    next: number;
    /** The caller's `after` was out of range: replace the whole text instead */
    reset?: boolean;
}

/** Everything the SSR page needs: the stored link plus the current text */
export interface ThinkingDocument {
    row: ThinkingLinkRow;
    model: string | null;
    createdAt: string;
    done: boolean;
    status: ThinkingStatus;
    errorMessage: string | null;
    text: string;
}
