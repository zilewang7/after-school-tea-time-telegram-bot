// Pure helpers for the share UI: the target's API query, the t.me share sheet URL and its text.

import { match } from 'ts-pattern';
import type { ShareCreateRequest, ShareKind, ShareQuery } from '../api';

/** What a share bar can point at: one pinned reply version, or a whole conversation */
export type ShareTarget =
    | { kind: 'reply'; chatId: number; firstMessageId: number; versionId: number }
    | { kind: 'conversation'; chatId: number; rootId: number };

/** GET /api/shares query for the target's active link */
export const shareQueryOf = (target: ShareTarget): ShareQuery =>
    match(target)
        .returnType<ShareQuery>()
        .with({ kind: 'reply' }, (reply) => ({
            kind: 'reply',
            chatId: reply.chatId,
            firstMessageId: reply.firstMessageId,
            rootId: null,
            versionId: reply.versionId,
        }))
        .with({ kind: 'conversation' }, (conversation) => ({
            kind: 'conversation',
            chatId: conversation.chatId,
            firstMessageId: null,
            rootId: conversation.rootId,
            versionId: null,
        }))
        .exhaustive();

/** POST /api/shares body for the target; a reply share pins the selected version */
export const shareCreateRequestOf = (target: ShareTarget): ShareCreateRequest =>
    match(target)
        .returnType<ShareCreateRequest>()
        .with({ kind: 'reply' }, (reply) => ({
            kind: 'reply',
            chatId: reply.chatId,
            firstMessageId: reply.firstMessageId,
            versionId: reply.versionId,
        }))
        .with({ kind: 'conversation' }, (conversation) => ({
            kind: 'conversation',
            chatId: conversation.chatId,
            rootId: conversation.rootId,
        }))
        .exhaustive();

/** The text sent along with the link, e.g. 「来自 <群名> 的 bot 回复」 */
export const shareTextOf = (chatName: string, kind: ShareKind): string =>
    kind === 'reply' ? `来自 ${chatName} 的 bot 回复` : `来自 ${chatName} 的对话分享`;

const TELEGRAM_SHARE_URL = 'https://t.me/share/url';

/** The t.me share sheet URL: openTelegramLink accepts t.me links only */
export const telegramShareUrlOf = (url: string, text: string): string =>
    `${TELEGRAM_SHARE_URL}?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
