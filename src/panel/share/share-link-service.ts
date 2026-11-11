/**
 * The share service of the panel (design §5.6): create, reuse, look up and
 * revoke share links, and keep their preview image (the widget render) ready.
 *
 * Two entry points matter outside the panel:
 * - `ensureSystemReplyShare` is called by the bot's group link fallback while
 *   it delivers a widget. That version is not finalized yet, so a system share
 *   accepts the pending version id and takes an optional content snapshot for
 *   the preview image. It never throws: a null means "send the link without a
 *   preview" (design §9).
 * - `ensurePreviewImage` makes sure a link has its image before it is sent.
 *
 * Reuse rule: one active row per target (+ version for replies), whoever
 * created it, so every member who shares the same reply gets the same URL.
 */
import { findBotResponseInChat, findRootMessage, getContextMessage } from '../../db/queries/context-queries.js';
import { loadShareContent, type ShareContent } from './share-content.js';
import { renderPreviewImage } from './preview-card.js';
import {
    findActiveReplyShareRows,
    findActiveShareRow,
    findShareRowByToken,
    insertShareRow,
    markShareRevoked,
    recordShareView,
    updateSharePreview,
    type ShareTargetFilter,
} from './share-store.js';
import {
    SHARE_CREATE_FAILURES,
    type PreviewSnapshot,
    type ShareCreateFailure,
    type ShareKind,
    type ShareLinkRecord,
    type ShareLinkView,
    type ShareRow,
} from './share-types.js';
import { isShareToken } from './token.js';
import { shareUrlOf } from './share-urls.js';

/** One widget render for the preview; a cold sidecar takes ~1.6s */
const PREVIEW_BUDGET_MS = 8_000;

/** Page views are counted at most once per link per 10 minutes */
const VIEW_COUNT_THROTTLE_MS = 10 * 60 * 1000;

const logFailure = (message: string, error: unknown): void => {
    console.warn(`[share] ${message}:`, error);
};

/** Run a preview render under the card budget; null when it takes too long */
const renderWithinBudget = async (snapshot: PreviewSnapshot): Promise<Awaited<ReturnType<typeof renderPreviewImage>>> => {
    let budgetTimer: NodeJS.Timeout | undefined;
    const budgetSpent = new Promise<null>((resolve) => {
        budgetTimer = setTimeout(() => resolve(null), PREVIEW_BUDGET_MS);
    });
    try {
        return await Promise.race([renderPreviewImage(snapshot), budgetSpent]);
    } finally {
        // A render that finished in time must not leave the budget timer running
        clearTimeout(budgetTimer);
    }
};

const recordOf = (row: ShareRow): ShareLinkRecord => ({
    token: row.token,
    url: shareUrlOf(row.token),
    kind: row.kind,
    chatId: row.chatId,
    firstMessageId: row.firstMessageId,
    rootId: row.rootId,
    versionId: row.versionId,
    createdBy: row.createdBy,
    source: row.source,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
    viewCount: row.viewCount,
    previewWidth: row.previewWidth,
    previewHeight: row.previewHeight,
});

/** What the requester may do with one link */
export const toShareLinkView = (row: ShareRow, user: { userId: number; isOwner: boolean }): ShareLinkView => ({
    ...recordOf(row),
    canRevoke: row.revokedAt === null && (user.isOwner || (row.source === 'user' && row.createdBy === user.userId)),
});

/** Store a rendered card on a link; false when the renderer is off or failed */
const storePreview = async (token: string, snapshot: PreviewSnapshot): Promise<boolean> => {
    try {
        const image = await renderWithinBudget(snapshot);
        if (image === null) return false;
        await updateSharePreview(token, image);
        return true;
    } catch (error) {
        logFailure(`rendering the preview image of ${token} failed`, error);
        return false;
    }
};

/** The snapshot the bot hands over at delivery time (the version is not stored yet) */
export interface SystemSharePreviewInput {
    /** Final widget HTML of the version being delivered */
    widgetHtml?: string;
    /** 600px rendered widget PNG (base64) */
    widgetImageBase64?: string;
    /** Image attachment bytes (base64) */
    imageBase64?: string;
    caption?: string | null;
    chatTitle?: string | null;
    /** Reply text of the version being delivered, when already known */
    text?: string;
}

export interface SystemReplyShareInput {
    chatId: number;
    firstMessageId: number;
    /** The 1-based version being delivered: stored already, or the one finalize is about to append */
    versionId: number;
    /** Content of the pending version, so the card is ready before Telegram crawls the page */
    preview?: SystemSharePreviewInput;
}

const snapshotOfSystemPreview = (preview: SystemSharePreviewInput | undefined): PreviewSnapshot | null => {
    if (preview === undefined) return null;
    const hasContent =
        preview.widgetHtml !== undefined ||
        preview.widgetImageBase64 !== undefined ||
        preview.imageBase64 !== undefined ||
        (preview.text ?? '') !== '';
    if (!hasContent) return null;
    return {
        chatTitle: preview.chatTitle ?? null,
        createdAt: new Date().toISOString(),
        text: preview.text ?? '',
        ...(preview.widgetHtml === undefined ? {} : { widgetHtml: preview.widgetHtml }),
        ...(preview.widgetImageBase64 === undefined ? {} : { widgetImageBase64: preview.widgetImageBase64 }),
        ...(preview.imageBase64 === undefined ? {} : { imageBase64: preview.imageBase64 }),
        caption: preview.caption ?? null,
    };
};

/**
 * The bot's own share of one reply version (group link fallback). Reuses the
 * active row, otherwise creates one with `createdBy=0, source='system'` and
 * renders its preview image. Never throws; null = no share page available.
 */
export const ensureSystemReplyShare = async (input: SystemReplyShareInput): Promise<ShareLinkRecord | null> => {
    try {
        const response = await findBotResponseInChat(input.chatId, input.firstMessageId);
        if (response === null) return null;
        const versions = response.getVersions();
        const pendingVersion = input.versionId === versions.length + 1;
        const knownVersion = versions.some((version) => version.versionId === input.versionId);
        if (!pendingVersion && !knownVersion) return null;

        const filter: ShareTargetFilter = {
            kind: 'reply',
            chatId: input.chatId,
            firstMessageId: input.firstMessageId,
            rootId: null,
            versionId: input.versionId,
        };
        const snapshot = snapshotOfSystemPreview(input.preview);
        const existing = await findActiveShareRow(filter);
        if (existing !== null) {
            if (existing.previewImageBase64 === null) {
                // A fresh snapshot first; a re-send can read the stored version instead
                if (snapshot !== null) await storePreview(existing.token, snapshot);
                else await ensurePreviewImage(existing.token);
            }
            const fresh = await findShareRowByToken(existing.token);
            return recordOf(fresh ?? existing);
        }

        const row = await insertShareRow({
            ...filter,
            createdBy: 0,
            source: 'system',
            createdAt: new Date().toISOString(),
        });
        if (snapshot !== null) {
            await storePreview(row.token, snapshot);
        } else {
            // A re-send of an already stored version: the content can be read from the database
            await ensurePreviewImage(row.token);
        }
        const fresh = await findShareRowByToken(row.token);
        return recordOf(fresh ?? row);
    } catch (error) {
        logFailure(`creating the system share of ${input.chatId}/${input.firstMessageId} failed`, error);
        return null;
    }
};

/** Make sure an active link has its preview image; false when it cannot be made */
export const ensurePreviewImage = async (token: string): Promise<boolean> => {
    try {
        if (!isShareToken(token)) return false;
        const row = await findShareRowByToken(token);
        if (row === null || row.revokedAt !== null) return false;
        if (row.previewImageBase64 !== null) return true;
        const content = await loadShareContent(row);
        if (content === null) return false;
        return await storePreview(token, content.preview);
    } catch (error) {
        logFailure(`ensuring the preview image of ${token} failed`, error);
        return false;
    }
};

export interface ShareTargetInput {
    kind: ShareKind;
    chatId: number;
    firstMessageId?: number;
    rootId?: number;
    versionId?: number;
}

export type ShareTargetResolution =
    | { ok: true; filter: ShareTargetFilter }
    | { ok: false; reason: ShareCreateFailure };

const replyTarget = async (input: ShareTargetInput): Promise<ShareTargetResolution> => {
    const firstMessageId = input.firstMessageId;
    if (firstMessageId === undefined || !Number.isSafeInteger(firstMessageId) || firstMessageId < 1) {
        return { ok: false, reason: SHARE_CREATE_FAILURES.invalidTarget };
    }
    const response = await findBotResponseInChat(input.chatId, firstMessageId);
    if (response === null) return { ok: false, reason: SHARE_CREATE_FAILURES.replyNotFound };
    const versions = response.getVersions();
    const current = response.getCurrentVersion();
    if (current === null) return { ok: false, reason: SHARE_CREATE_FAILURES.versionNotFound };
    // A named version must exist (strict, unlike page rendering which falls back to current)
    const versionId = input.versionId ?? current.versionId;
    if (!versions.some((version) => version.versionId === versionId)) {
        return { ok: false, reason: SHARE_CREATE_FAILURES.versionNotFound };
    }
    return {
        ok: true,
        filter: { kind: 'reply', chatId: input.chatId, firstMessageId, rootId: null, versionId },
    };
};

const conversationTarget = async (input: ShareTargetInput): Promise<ShareTargetResolution> => {
    const rootId = input.rootId;
    if (rootId === undefined || !Number.isSafeInteger(rootId) || rootId < 1) {
        return { ok: false, reason: SHARE_CREATE_FAILURES.invalidTarget };
    }
    const root = await getContextMessage(input.chatId, rootId);
    const chainRoot = root === null ? null : await findRootMessage(input.chatId, rootId, { recover: false });
    if (root === null || chainRoot?.messageId !== rootId) {
        return { ok: false, reason: SHARE_CREATE_FAILURES.conversationNotFound };
    }
    return {
        ok: true,
        filter: { kind: 'conversation', chatId: input.chatId, firstMessageId: null, rootId, versionId: null },
    };
};

/** Validate a target and reduce it to the reuse key */
export const resolveShareTarget = async (input: ShareTargetInput): Promise<ShareTargetResolution> =>
    input.kind === 'reply' ? replyTarget(input) : conversationTarget(input);

export interface CreateUserShareInput extends ShareTargetInput {
    createdBy: number;
    /**
     * Whether reusing an existing link may render its missing preview image;
     * the bot commands pass false (design §4.6), the panel keeps the default.
     */
    ensurePreviewOnReuse?: boolean;
}

export type CreateUserShareResult =
    | { ok: true; share: ShareLinkRecord; created: boolean }
    | { ok: false; reason: ShareCreateFailure };

/**
 * A panel user's share: reuse the active row of the same target, else create
 * one and render its preview image. The caller has already checked chat access.
 */
export const createUserShare = async (input: CreateUserShareInput): Promise<CreateUserShareResult> => {
    const target = await resolveShareTarget(input);
    if (!target.ok) return target;

    const existing = await findActiveShareRow(target.filter);
    if (existing !== null) {
        if (input.ensurePreviewOnReuse !== false && existing.previewImageBase64 === null) {
            await ensurePreviewImage(existing.token);
        }
        const fresh = await findShareRowByToken(existing.token);
        return { ok: true, share: recordOf(fresh ?? existing), created: false };
    }

    const row = await insertShareRow({
        ...target.filter,
        createdBy: input.createdBy,
        source: 'user',
        createdAt: new Date().toISOString(),
    });
    await ensurePreviewImage(row.token);
    const fresh = await findShareRowByToken(row.token);
    return { ok: true, share: recordOf(fresh ?? row), created: true };
};

/** The active share behind a token; null for unknown, revoked or malformed tokens */
export const findActiveShare = async (token: string): Promise<ShareLinkRecord | null> => {
    if (!isShareToken(token)) return null;
    const row = await findShareRowByToken(token);
    if (row === null || row.revokedAt !== null) return null;
    return recordOf(row);
};

/** The active share of a target, as the panel's share status shows it */
export const findShareStatus = async (
    input: ShareTargetInput,
    user: { userId: number; isOwner: boolean }
): Promise<ShareLinkView | null> => {
    const target = await resolveShareTarget(input);
    if (!target.ok) return null;
    return findActiveShareView(target.filter, user);
};

/** The active share behind an already validated target */
export const findActiveShareView = async (
    filter: ShareTargetFilter,
    user: { userId: number; isOwner: boolean }
): Promise<ShareLinkView | null> => {
    const row = await findActiveShareRow(filter);
    return row === null ? null : toShareLinkView(row, user);
};

/** Active share URL per version of one reply, for the reply detail's share status */
export const findActiveReplyShareUrls = async (
    chatId: number,
    firstMessageId: number
): Promise<Map<number, string>> => {
    const rows = await findActiveReplyShareRows(chatId, firstMessageId);
    const urls = new Map<number, string>();
    for (const row of rows) {
        if (row.versionId === null || urls.has(row.versionId)) continue;
        urls.set(row.versionId, shareUrlOf(row.token));
    }
    return urls;
};

export type RevokeShareResult = 'revoked' | 'forbidden' | 'not_found';

/** Revoke a link: its creator or the owner, nothing else */
export const revokeShare = async (
    token: string,
    user: { userId: number; isOwner: boolean }
): Promise<RevokeShareResult> => {
    if (!isShareToken(token)) return 'not_found';
    const row = await findShareRowByToken(token);
    if (row === null || row.revokedAt !== null) return 'not_found';
    if (!user.isOwner && row.createdBy !== user.userId) return 'forbidden';
    const revoked = await markShareRevoked(token, new Date().toISOString());
    return revoked ? 'revoked' : 'not_found';
};

/** One active link and its page content, for the public routes */
export interface PublicShare {
    row: ShareRow;
    content: ShareContent;
}

export const loadPublicShare = async (token: string): Promise<PublicShare | null> => {
    if (!isShareToken(token)) return null;
    const row = await findShareRowByToken(token);
    if (row === null || row.revokedAt !== null) return null;
    const content = await loadShareContent(row);
    if (content === null) return null;
    return { row, content };
};

/**
 * The URL the group fallback's link preview points at (design §18). It answers
 * Telegram's crawler with the widget render, so the preview is only the picture,
 * and a browser with the page itself, so tapping it reveals the card instead of
 * a bare image file. Null when no widget render was stored: nothing to force.
 */
export const previewLinkUrlOf = (share: ShareLinkRecord): string | null =>
    share.previewWidth === null || share.previewHeight === null ? null : `${share.url}/preview`;

/** Count one page view (throttled; failures are not the page's problem) */
export const recordSharePageView = (token: string): void => {
    recordShareView(token, new Date(), VIEW_COUNT_THROTTLE_MS).catch((error: unknown) => {
        logFailure(`counting a view of ${token} failed`, error);
    });
};

/** The public URL of a token (contract export) */
export { shareUrlOf } from './share-urls.js';
