/**
 * The exclusion endpoints, members only: take messages out of the model's
 * context for the whole chat, or put them back (design §6.2 排除的语义).
 *
 * PUT / DELETE /api/chats/:chatId/messages/:messageId/exclusion — one message.
 * The id is normalized first: a continuation message of a bot reply becomes the
 * reply's first message. A message we do not have is a 404; an album's
 * sub-image is a 400 (excluding the album's first message takes the whole album
 * out). Repeating either write answers 200 and audits nothing.
 *
 * POST /api/chats/:chatId/exclusions { action, messageIds } — 1–100 ids at
 * once (design 2026-1119-2016 §4.5). Ids are normalized and classified one by
 * one: the ones we do not have come back in `missing`, album sub-images in
 * `albumItems`, both skipped instead of failing the whole request. The rest go
 * through one batch transaction that audits one row per changed id, exactly
 * like the single-message endpoint.
 *
 * Both kinds of write report what changed on the conversation's `/panel`
 * message, when the chat has one (design 2026-1119-2016 §4.7). Fire and forget:
 * the receipt never affects the answer. The optional `rootId` (a query
 * parameter of the single write, a body key of the batch) names the
 * conversation the panel was operating in: its tree also shows messages
 * spliced in from other conversations, and without it those writes would find
 * no receipt at all (their own roots are registered nowhere).
 */
import type { Api } from 'grammy';
import type { Hono } from 'hono';
import { match } from 'ts-pattern';
import { findBotResponseByMessageId } from '../../db/index.js';
import {
    excludeMany,
    excludeMessage,
    includeMany,
    includeMessage,
    type ExclusionBatchResult,
} from '../../db/queries/context-exclusions.js';
import { getContextMessage } from '../../db/queries/context-queries.js';
import { isSubImage } from '../../reply/context-assembly.js';
import { reportExclusionReceipt } from '../../services/conversation-keyboard-service.js';
import { requireChatAccess } from '../access/require-access.js';
import { requireAuth, type PanelContext, type PanelEnv } from '../context.js';
import { PanelError } from '../errors.js';
import { checkBodyKeys, invalid, parseChatId, parseOptionalPositiveInteger, readJsonObject } from '../request.js';
import { CONVERSATION_MESSAGES, parseMessageIdParam, requireMember } from './conversation-params.js';

/** What the route needs from outside the request: the bot's Api for in-chat receipts */
export interface ExclusionRouteDeps {
    /** The bot's own Api; null (offline cases, no api) disables the receipts */
    botApi: Api | null;
}

/** The two directions a batch write can take */
export type ExclusionBatchAction = 'exclude' | 'restore';

export interface ExcludedMessageView {
    messageId: number;
    excluded: true;
    createdAt: string;
    createdBy: number;
}

export interface IncludedMessageView {
    messageId: number;
    excluded: false;
}

export interface ExclusionBatchView {
    action: ExclusionBatchAction;
    /** Ids the write changed, canonical (a bot reply's firstMessageId) */
    changed: number[];
    /** Ids already in the target state */
    unchanged: number[];
    /** Ids we no longer have: skipped */
    missing: number[];
    /** Album sub-image ids: an album cannot lose one picture on its own */
    albumItems: number[];
}

const ACTION_KEY = 'action';
const MESSAGE_IDS_KEY = 'messageIds';
/** The conversation the panel operated in: the receipt's target */
const ROOT_ID_KEY = 'rootId';
const ALLOWED_BATCH_KEYS: ReadonlySet<string> = new Set([ACTION_KEY, MESSAGE_IDS_KEY, ROOT_ID_KEY]);
/** One batch write, matching the webapp's selection limit */
const MAX_BATCH_MESSAGE_IDS = 100;

/** The optional operated-conversation id of a batch body */
const parseOptionalRootId = (raw: unknown): number | undefined => {
    if (raw === undefined) return undefined;
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) throw invalid('rootId 必须是正整数');
    return raw;
};

/** What one requested id resolves to */
type ExclusionTarget =
    | { kind: 'message'; messageId: number }
    | { kind: 'missing' }
    | { kind: 'albumItem' };

/**
 * Normalize one requested id: a bot reply's continuation becomes its first
 * message, then the stored row decides whether it can be excluded at all.
 */
const resolveExclusionTarget = async (chatId: number, requestedId: number): Promise<ExclusionTarget> => {
    const reply = await findBotResponseByMessageId(chatId, requestedId);
    const messageId = reply?.messageId ?? requestedId;
    const message = await getContextMessage(chatId, messageId);
    if (message === null) return { kind: 'missing' };
    if (isSubImage(message)) return { kind: 'albumItem' };
    return { kind: 'message', messageId };
};

/** The id an exclusion is stored under; 404 / 400 for what cannot be excluded */
const canonicalExclusionId = async (chatId: number, messageId: number): Promise<number> => {
    const target = await resolveExclusionTarget(chatId, messageId);
    return match(target)
        .with({ kind: 'message' }, ({ messageId: canonicalId }) => canonicalId)
        .with({ kind: 'missing' }, () => {
            throw new PanelError('not_found', CONVERSATION_MESSAGES.messageNotFound);
        })
        .with({ kind: 'albumItem' }, () => {
            throw invalid('相册里的单张图片不能单独排除，请排除相册的第一条消息（整组图片会一起离开上下文）');
        })
        .exhaustive();
};

/** Access, member gate and the normalized target of one exclusion request */
const readExclusionRequest = async (
    context: PanelContext
): Promise<{ chatId: number; messageId: number; actorId: number; rootId: number | undefined }> => {
    const auth = requireAuth(context);
    const chatId = parseChatId(context.req.param('chatId'));
    requireMember(await requireChatAccess(auth, chatId));
    const requestedId = parseMessageIdParam(context.req.param('messageId'), 'messageId');
    const rootId = parseOptionalPositiveInteger(context.req.query(ROOT_ID_KEY), ROOT_ID_KEY);
    return { chatId, messageId: await canonicalExclusionId(chatId, requestedId), actorId: auth.user.id, rootId };
};

const parseBatchAction = (raw: unknown): ExclusionBatchAction => {
    if (raw === 'exclude' || raw === 'restore') return raw;
    throw invalid('action 必须是 exclude 或 restore');
};

/** 1–100 positive integers, deduplicated in the order they were sent */
const parseBatchMessageIds = (raw: unknown): number[] => {
    if (!Array.isArray(raw)) throw invalid('messageIds 必须是正整数数组');
    if (raw.length < 1 || raw.length > MAX_BATCH_MESSAGE_IDS) {
        throw invalid(`messageIds 需要 1 到 ${MAX_BATCH_MESSAGE_IDS} 个`);
    }
    const requested = new Set<number>();
    const messageIds: number[] = [];
    for (const item of raw) {
        if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1) {
            throw invalid('messageIds 必须是正整数数组');
        }
        if (requested.has(item)) continue;
        requested.add(item);
        messageIds.push(item);
    }
    return messageIds;
};

interface ExclusionBatchTargets {
    /** Canonical ids ready for the write, input order, no duplicates */
    canonicalIds: number[];
    missing: number[];
    albumItems: number[];
}

/** Classify every requested id; the order of the input is kept in each list */
const resolveBatchTargets = async (
    chatId: number,
    requestedIds: readonly number[]
): Promise<ExclusionBatchTargets> => {
    const targets: ExclusionBatchTargets = { canonicalIds: [], missing: [], albumItems: [] };
    const seen = new Set<number>();
    for (const requestedId of requestedIds) {
        const target = await resolveExclusionTarget(chatId, requestedId);
        match(target)
            .with({ kind: 'message' }, ({ messageId }) => {
                // Two requested ids can normalize to the same reply (first + continuation)
                if (seen.has(messageId)) return;
                seen.add(messageId);
                targets.canonicalIds.push(messageId);
            })
            .with({ kind: 'missing' }, () => targets.missing.push(requestedId))
            .with({ kind: 'albumItem' }, () => targets.albumItems.push(requestedId))
            .exhaustive();
    }
    return targets;
};

const writeBatch = (
    action: ExclusionBatchAction,
    chatId: number,
    messageIds: readonly number[],
    actorId: number
): Promise<ExclusionBatchResult> =>
    match(action)
        .with('exclude', () => excludeMany({ chatId, messageIds, actorId }))
        .with('restore', () => includeMany({ chatId, messageIds, actorId }))
        .exhaustive();

export const registerExclusionRoutes = (app: Hono<PanelEnv>, deps: ExclusionRouteDeps): void => {
    app.put('/api/chats/:chatId/messages/:messageId/exclusion', async (context) => {
        const { chatId, messageId, actorId, rootId } = await readExclusionRequest(context);
        const { row, created } = await excludeMessage({ chatId, messageId, actorId });
        if (created) {
            void reportExclusionReceipt({
                chatId,
                messageIds: [row.messageId],
                action: 'exclude',
                botApi: deps.botApi,
                rootId,
            });
        }
        const view: ExcludedMessageView = {
            messageId: row.messageId,
            excluded: true,
            createdAt: row.createdAt.toISOString(),
            createdBy: row.createdBy,
        };
        return context.json(view);
    });

    app.delete('/api/chats/:chatId/messages/:messageId/exclusion', async (context) => {
        const { chatId, messageId, actorId, rootId } = await readExclusionRequest(context);
        const removed = await includeMessage({ chatId, messageId, actorId });
        if (removed) {
            void reportExclusionReceipt({
                chatId,
                messageIds: [messageId],
                action: 'restore',
                botApi: deps.botApi,
                rootId,
            });
        }
        const view: IncludedMessageView = { messageId, excluded: false };
        return context.json(view);
    });

    app.post('/api/chats/:chatId/exclusions', async (context) => {
        const auth = requireAuth(context);
        const chatId = parseChatId(context.req.param('chatId'));
        requireMember(await requireChatAccess(auth, chatId));

        const body = await readJsonObject(context);
        checkBodyKeys(body, ALLOWED_BATCH_KEYS);
        const action = parseBatchAction(body[ACTION_KEY]);
        const requestedIds = parseBatchMessageIds(body[MESSAGE_IDS_KEY]);
        const rootId = parseOptionalRootId(body[ROOT_ID_KEY]);

        const targets = await resolveBatchTargets(chatId, requestedIds);
        const written = await writeBatch(action, chatId, targets.canonicalIds, auth.user.id);
        if (written.changed.length > 0) {
            void reportExclusionReceipt({
                chatId,
                messageIds: written.changed,
                action,
                botApi: deps.botApi,
                rootId,
            });
        }
        const view: ExclusionBatchView = {
            action,
            changed: written.changed,
            unchanged: written.unchanged,
            missing: targets.missing,
            albumItems: targets.albumItems,
        };
        return context.json(view);
    });
};
