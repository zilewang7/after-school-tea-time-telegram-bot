/**
 * The `avatar` argument of fetch_image: one string the model wrote → the one
 * thing to look up.
 *
 * The forms are deliberately few and unambiguous: keywords (`me`, `bot`,
 * `chat`, `this`), a context number (`#3`), an @handle, a numeric id (negative
 * = chat, positive = user) or a t.me link. A bare number is never a context
 * number: `#` is what makes it one, so a model that writes `3` gets a "user 3
 * not found" answer that tells it to write `#3`.
 */
import type { AvatarTarget } from '../../services/avatar-service.js';
import type { ContextIndex } from '../context-index.js';

export interface AvatarTargetOptions {
    readonly chatId: number;
    /** Null when BOT_USER_ID is unset: `me` cannot be resolved then */
    readonly botUserId: number | null;
    readonly contextIndex: ContextIndex;
}

export type ParsedAvatarTarget =
    | { readonly ok: true; readonly target: AvatarTarget }
    | { readonly ok: false; readonly error: string };

export const AVATAR_TARGET_HINT =
    "可以写 'me'（我自己）、'chat'（当前聊天）、'#3'（上下文编号）、'@username'、" +
    '数字 id（正数=用户，负数=群/频道）或 t.me 链接';

const CONTEXT_NUMBER_PATTERN = /^#\s*(\d+)$/;
const NUMERIC_ID_PATTERN = /^-?\d+$/;
/** Telegram handles: 4-32 chars of [A-Za-z0-9_] */
const HANDLE_PATTERN = /^[A-Za-z0-9_]{4,32}$/;
const TELEGRAM_LINK_PATTERN = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(.+)$/i;
const INTERNAL_LINK_PATTERN = /^\d+$/;

const invalidTarget = (text: string): ParsedAvatarTarget => ({
    ok: false,
    error: `无法识别的头像目标「${text}」：${AVATAR_TARGET_HINT}。`,
});

const usernameTarget = (raw: string, original: string): ParsedAvatarTarget => {
    if (!HANDLE_PATTERN.test(raw)) return invalidTarget(original);
    return { ok: true, target: { kind: 'username', username: raw.toLowerCase() } };
};

/** `t.me/<handle>`, `t.me/s/<handle>`, `t.me/c/<internal>/<message>` */
const parseTelegramLink = (path: string, original: string): ParsedAvatarTarget => {
    const segments = path.split('/').filter((segment) => segment !== '');
    const first = (segments[0] ?? '').toLowerCase();

    if (first === 'c') {
        const internal = segments[1] ?? '';
        if (!INTERNAL_LINK_PATTERN.test(internal)) return invalidTarget(original);
        const chatId = Number(`-100${internal}`);
        if (!Number.isSafeInteger(chatId)) return invalidTarget(original);
        return { ok: true, target: { kind: 'chat', chatId } };
    }
    // A preview link (t.me/s/<channel>) still names the channel
    if (first === 's' && segments[1] !== undefined) return usernameTarget(segments[1], original);
    if (first.startsWith('+') || first === 'joinchat') {
        return { ok: false, error: `「${original}」是邀请链接，没有公开用户名，取不到头像。` };
    }
    return usernameTarget(segments[0] ?? '', original);
};

export const parseAvatarTarget = (raw: string, options: AvatarTargetOptions): ParsedAvatarTarget => {
    const text = raw.trim();
    if (text === '') return { ok: false, error: `avatar 不能为空：${AVATAR_TARGET_HINT}。` };

    const keyword = text.toLowerCase();
    if (keyword === 'me' || keyword === 'bot') {
        if ((options.botUserId ?? null) === null) {
            return { ok: false, error: '没有配置 BOT_USER_ID，取不到我的头像。' };
        }
        return { ok: true, target: { kind: 'bot' } };
    }
    if (keyword === 'chat' || keyword === 'this') {
        return { ok: true, target: { kind: 'chat', chatId: options.chatId } };
    }

    const contextMatch = CONTEXT_NUMBER_PATTERN.exec(text);
    if (contextMatch !== null) {
        const number = Number(contextMatch[1]);
        const entry = options.contextIndex.get(number);
        if (entry === undefined) return { ok: false, error: `#${number} 不在当前上下文里。` };
        if (entry.authorUserId === undefined || entry.authorUserId === null) {
            return { ok: false, error: `#${number} 没有记录作者 id（早期消息），取不到头像。` };
        }
        return {
            ok: true,
            target: {
                kind: 'user',
                userId: entry.authorUserId,
                context: { number, name: entry.authorName ?? '' },
            },
        };
    }

    if (text.startsWith('@')) return usernameTarget(text.slice(1), text);

    const linkMatch = TELEGRAM_LINK_PATTERN.exec(text);
    if (linkMatch !== null) return parseTelegramLink(linkMatch[1] ?? '', text);

    if (NUMERIC_ID_PATTERN.test(text)) {
        const id = Number(text);
        if (!Number.isSafeInteger(id) || id === 0) return invalidTarget(text);
        return { ok: true, target: id < 0 ? { kind: 'chat', chatId: id } : { kind: 'user', userId: id } };
    }

    return invalidTarget(text);
};
