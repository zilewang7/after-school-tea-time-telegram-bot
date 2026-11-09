/**
 * The share API of the panel (design §5.6): create, read and revoke a share
 * link. Everything goes through initData plus the chat access gate:
 * - a reply share is open to members and observers (it only contains bot
 *   output);
 * - a conversation share is members only (it contains user names and text);
 * - revoking is the creator's or the owner's call.
 *
 * `SHARE_ENABLED=0` registers nothing here, so the paths fall through to the
 * JSON 404 (design §7.4).
 */
import type { Hono } from 'hono';
import { match } from 'ts-pattern';
import { requireChatAccess } from '../access/require-access.js';
import { requireAuth, type PanelEnv } from '../context.js';
import { PANEL_MESSAGES, PanelError } from '../errors.js';
import { checkBodyKeys, invalid, parseChatId, parseOptionalPositiveInteger, readJsonObject } from '../request.js';
import {
    createUserShare,
    findActiveShareView,
    revokeShare,
    resolveShareTarget,
    type ShareTargetInput,
} from '../share/share-link-service.js';
import { SHARE_CREATE_FAILURES, type ShareCreateFailure, type ShareKind } from '../share/share-types.js';

const CREATE_BODY_KEYS: ReadonlySet<string> = new Set(['kind', 'chatId', 'firstMessageId', 'rootId', 'versionId']);
const OBSERVER_CONVERSATION_MESSAGE = '观察者只能分享单条回复';
const REVOKE_FORBIDDEN_MESSAGE = '只有创建者或机主可以撤销分享';
const REVOKE_MISSING_MESSAGE = '分享链接不存在或已撤销';

const parseKind = (raw: unknown): ShareKind => {
    if (raw === 'reply' || raw === 'conversation') return raw;
    throw invalid('kind 必须是 reply 或 conversation');
};

/** chatId from a JSON body (a number, as the webapp sends it) */
const parseBodyChatId = (raw: unknown): number => {
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw === 0) {
        throw invalid(PANEL_MESSAGES.invalidChatId);
    }
    return raw;
};

const positiveIntegerOf = (raw: unknown, name: string): number | undefined => {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) throw invalid(`${name} 必须是正整数`);
    return raw;
};

/** The optional target ids, present only when given */
const targetFieldsOf = (
    firstMessageId: number | undefined,
    rootId: number | undefined,
    versionId: number | undefined
): Pick<ShareTargetInput, 'firstMessageId' | 'rootId' | 'versionId'> => ({
    ...(firstMessageId === undefined ? {} : { firstMessageId }),
    ...(rootId === undefined ? {} : { rootId }),
    ...(versionId === undefined ? {} : { versionId }),
});

const targetOf = (kind: ShareKind, chatId: number, body: Record<string, unknown>): ShareTargetInput => ({
    kind,
    chatId,
    ...targetFieldsOf(
        positiveIntegerOf(body.firstMessageId, 'firstMessageId'),
        positiveIntegerOf(body.rootId, 'rootId'),
        positiveIntegerOf(body.versionId, 'versionId')
    ),
});

const createFailureOf = (reason: ShareCreateFailure): PanelError =>
    match(reason)
        .with(SHARE_CREATE_FAILURES.invalidTarget, () => invalid('分享目标不合法'))
        .with(SHARE_CREATE_FAILURES.replyNotFound, () => new PanelError('not_found', '这条回复不存在'))
        .with(SHARE_CREATE_FAILURES.versionNotFound, () => new PanelError('not_found', '这个版本不存在'))
        .with(SHARE_CREATE_FAILURES.conversationNotFound, () => new PanelError('not_found', '这段对话不存在'))
        .exhaustive();

/** Observers may share one reply but never a whole conversation */
const requireConversationMember = (access: 'member' | 'observer'): void => {
    if (access !== 'member') throw new PanelError('forbidden', OBSERVER_CONVERSATION_MESSAGE);
};

export const registerShareRoutes = (app: Hono<PanelEnv>): void => {
    app.post('/api/shares', async (context) => {
        const auth = requireAuth(context);
        const body = await readJsonObject(context);
        checkBodyKeys(body, CREATE_BODY_KEYS, ['kind', 'chatId']);
        const kind = parseKind(body.kind);
        const chatId = parseBodyChatId(body.chatId);
        const { access } = await requireChatAccess(auth, chatId);
        if (kind === 'conversation') requireConversationMember(access);

        const result = await createUserShare({ ...targetOf(kind, chatId, body), createdBy: auth.user.id });
        if (!result.ok) throw createFailureOf(result.reason);
        return context.json({
            share: {
                ...result.share,
                canRevoke:
                    result.share.revokedAt === null &&
                    (auth.user.isOwner || (result.share.source === 'user' && result.share.createdBy === auth.user.id)),
            },
        });
    });

    app.get('/api/shares', async (context) => {
        const auth = requireAuth(context);
        const kind = parseKind(context.req.query('kind'));
        const chatId = parseChatId(context.req.query('chatId'));
        const { access } = await requireChatAccess(auth, chatId);
        if (kind === 'conversation') requireConversationMember(access);

        const target: ShareTargetInput = {
            kind,
            chatId,
            ...targetFieldsOf(
                parseOptionalPositiveInteger(context.req.query('firstMessageId'), 'firstMessageId'),
                parseOptionalPositiveInteger(context.req.query('rootId'), 'rootId'),
                parseOptionalPositiveInteger(context.req.query('versionId'), 'versionId')
            ),
        };
        const resolved = await resolveShareTarget(target);
        if (!resolved.ok && resolved.reason === SHARE_CREATE_FAILURES.invalidTarget) throw createFailureOf(resolved.reason);
        const share = resolved.ok
            ? await findActiveShareView(resolved.filter, { userId: auth.user.id, isOwner: auth.user.isOwner })
            : null;
        return context.json({ share });
    });

    app.post('/api/shares/:token/revoke', async (context) => {
        const auth = requireAuth(context);
        const result = await revokeShare(context.req.param('token'), {
            userId: auth.user.id,
            isOwner: auth.user.isOwner,
        });
        return match(result)
            .with('revoked', () => context.json({ ok: true }))
            .with('forbidden', () => {
                throw new PanelError('forbidden', REVOKE_FORBIDDEN_MESSAGE);
            })
            .with('not_found', () => {
                throw new PanelError('not_found', REVOKE_MISSING_MESSAGE);
            })
            .exhaustive();
    });
};
