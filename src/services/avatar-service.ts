/**
 * Telegram avatars: one target (bot / chat / user / @username) → the profile
 * picture bytes a model can look at.
 *
 * `getChat` is the only lookup: it answers a chat id, a user id and an
 * @username, and its ChatPhoto carries both sizes (160 and 640). The
 * `file_unique_id`s are exactly the ones `getUserProfilePhotos` reports for the
 * same picture (verified 2026-11-07), so the profile-photo API is not needed.
 *
 * Resolutions are cached for ten minutes: `getChat` is rate-limited (a 429 with
 * a 259s retry-after was observed once, see tg-message-link-service), and the
 * same few targets (this chat, this bot, the people talking) are asked about
 * over and over. Bytes are not cached — the local Bot API serves them from a
 * mounted disk in a few milliseconds, and caching them would only add a second
 * stale window.
 *
 * A username may belong to a user the bot has seen: the roster table maps those
 * to user ids, and `getChat('@handle')` cannot resolve a user (live check:
 * `@ritsumugi` is a group member and still answers "chat not found"). So a
 * username is tried through the roster first, verified against the username
 * `getChat` reports, and only then through the public lookup.
 */
import { sniffImageMime, type SniffedImageMime } from '../ai/image-generation/image-mime.js';
import {
    downloadTelegramFile,
    toTelegramApiAbortSignal,
    type TelegramApiAbortSignal,
} from './telegram-file-service.js';

export type AvatarView = 'original' | 'thumbnail';

/** Where the model pointed: the one thing a lookup starts from */
export type AvatarTarget =
    | { readonly kind: 'bot' }
    | { readonly kind: 'chat'; readonly chatId: number }
    | {
          readonly kind: 'user';
          readonly userId: number;
          /** Set when the target came from a context number (`#N`) */
          readonly context?: { readonly number: number; readonly name: string };
      }
    | { readonly kind: 'username'; readonly username: string };

/** The fields of getChat's answer an avatar needs; a grammY ChatFullInfo fits */
export interface AvatarChat {
    readonly id: number;
    readonly type: string;
    readonly title?: string;
    readonly first_name?: string;
    readonly last_name?: string;
    readonly username?: string;
    readonly photo?: {
        readonly small_file_id: string;
        readonly big_file_id: string;
    };
}

/** The Bot API surface; a test double implements the same three methods */
export interface AvatarApi {
    getChat(chatId: number | string, signal?: TelegramApiAbortSignal): Promise<AvatarChat>;
    getFile(fileId: string, signal?: TelegramApiAbortSignal): Promise<{ readonly file_path?: string }>;
}

export interface AvatarDependencies {
    readonly api: AvatarApi;
    /** @handle → user id from the roster; absent = usernames only go public */
    readonly lookupUsername?: (username: string) => Promise<number | null>;
    /** Test seam: the real download is getFile + the local/cloud file URL */
    readonly download?: (fileId: string, signal: AbortSignal) => Promise<Buffer>;
    /** Test seam for the resolution cache's clock */
    readonly now?: () => number;
    readonly botUserId?: number | null;
}

export interface ResolvedAvatar {
    /** `群聊「X」的头像` / `#7 作者「Y」的头像` / `我的头像` */
    readonly label: string;
    readonly data: Buffer;
    readonly mimeType: SniffedImageMime;
    readonly view: AvatarView;
}

export type AvatarOutcome =
    | { readonly ok: true; readonly avatar: ResolvedAvatar }
    | { readonly ok: false; readonly error: string };

/** One target's getChat answer, kept for the resolution cache */
interface CachedAvatarChat {
    readonly chat: AvatarChat;
    readonly expiresAt: number;
}

const RESOLUTION_TTL_MS = 10 * 60 * 1000;
const RESOLUTION_MAX_ENTRIES = 200;

const cachedChats = new Map<string, CachedAvatarChat>();
const inflightChats = new Map<string, Promise<AvatarChat>>();

/** Forget every resolution; tests call it between cases */
export const clearAvatarCache = (): void => {
    cachedChats.clear();
    inflightChats.clear();
};

/** The cache key of one target: `bot`, `chat:-100…`, `user:123`, `username:x` */
export const avatarTargetKey = (target: AvatarTarget): string => {
    switch (target.kind) {
        case 'bot':
            return 'bot';
        case 'chat':
            return `chat:${target.chatId}`;
        case 'user':
            return `user:${target.userId}`;
        case 'username':
            return `username:${target.username.toLowerCase()}`;
    }
};

const displayNameOf = (chat: AvatarChat): string => {
    if (chat.type !== 'private') {
        return chat.title ?? (chat.username === undefined ? `聊天 ${chat.id}` : `@${chat.username}`);
    }
    const name = [chat.first_name, chat.last_name].filter((part): part is string => Boolean(part)).join(' ');
    if (name !== '') return name;
    return chat.username === undefined ? `用户 ${chat.id}` : `@${chat.username}`;
};

const chatKindLabel = (chat: AvatarChat): string => {
    if (chat.type === 'private') return '私聊';
    if (chat.type === 'channel') return '频道';
    return '群聊';
};

/** How the model reads the picture it just got */
export const avatarLabel = (target: AvatarTarget, chat: AvatarChat): string => {
    if (target.kind === 'bot') return '我的头像';
    const name = displayNameOf(chat);
    if (target.kind === 'user' && target.context !== undefined) {
        const author = target.context.name === '' ? name : target.context.name;
        return `#${target.context.number} 作者「${author}」的头像`;
    }
    const handle = chat.username === undefined ? '' : `（@${chat.username}）`;
    if (target.kind === 'user' || target.kind === 'username') {
        const kind = chat.type === 'private' ? '用户' : chatKindLabel(chat);
        return `${kind}「${name}」${handle}的头像`;
    }
    return `${chatKindLabel(chat)}「${name}」的头像`;
};

const describeApiError = (error: unknown): { readonly code: number | null; readonly description: string } => {
    if (typeof error === 'object' && error !== null) {
        const code = 'error_code' in error && typeof error.error_code === 'number' ? error.error_code : null;
        if ('description' in error && typeof error.description === 'string') {
            return { code, description: error.description };
        }
    }
    return { code: null, description: error instanceof Error ? error.message : String(error) };
};

const NOT_FOUND_PATTERN = /chat not found|user not found|peer_id_invalid/i;

const notFoundMessage = (target: AvatarTarget): string => {
    switch (target.kind) {
        case 'bot':
            return '取不到我的头像（BOT_USER_ID 无效）。';
        case 'chat':
            return `找不到聊天 ${target.chatId}（bot 可能不在其中）。`;
        case 'user':
            return target.context === undefined
                ? `找不到用户 ${target.userId}（bot 没见过这个用户）。上下文编号要写成 '#3'。`
                : `找不到 #${target.context.number} 的作者（用户 ${target.userId}）。`;
        case 'username':
            return (
                `找不到「@${target.username}」：公开频道/群可以直接查；` +
                '用户的 @username 需要 bot 见过这个人，可以用上下文编号 #N。'
            );
    }
};

const noAvatarMessage = (target: AvatarTarget, chat: AvatarChat): string => {
    if (target.kind === 'bot') return '我没有设置头像。';
    const name = displayNameOf(chat);
    if (target.kind === 'user' && target.context !== undefined) {
        return `#${target.context.number} 的作者「${name}」没有设置头像（或头像对 bot 不可见）。`;
    }
    return `「${name}」没有设置头像（或头像对 bot 不可见）。`;
};

const failureMessage = (target: AvatarTarget, error: unknown): string => {
    const { code, description } = describeApiError(error);
    if (code === 400 && NOT_FOUND_PATTERN.test(description)) return notFoundMessage(target);
    return `取头像失败：${description}`;
};

const rememberChat = (key: string, chat: AvatarChat, now: number): void => {
    if (cachedChats.size >= RESOLUTION_MAX_ENTRIES && !cachedChats.has(key)) {
        const oldest = cachedChats.keys().next();
        if (!oldest.done) cachedChats.delete(oldest.value);
    }
    cachedChats.set(key, { chat, expiresAt: now + RESOLUTION_TTL_MS });
};

const lookupChat = async (
    target: AvatarTarget,
    dependencies: AvatarDependencies,
    signal: AbortSignal
): Promise<AvatarChat> => {
    switch (target.kind) {
        case 'bot': {
            // resolveAvatar refuses this case before it gets here
            const botUserId = dependencies.botUserId ?? null;
            if (botUserId === null) throw new Error('BOT_USER_ID is not configured');
            return dependencies.api.getChat(botUserId, toTelegramApiAbortSignal(signal));
        }
        case 'chat':
            return dependencies.api.getChat(target.chatId, toTelegramApiAbortSignal(signal));
        case 'user':
            return dependencies.api.getChat(target.userId, toTelegramApiAbortSignal(signal));
        case 'username': {
            const wanted = target.username.toLowerCase();
            const knownUserId = (await dependencies.lookupUsername?.(wanted)) ?? null;
            if (knownUserId !== null) {
                try {
                    const chat = await dependencies.api.getChat(knownUserId, toTelegramApiAbortSignal(signal));
                    // The handle may have moved to someone else since the roster row
                    if (chat.username?.toLowerCase() === wanted) return chat;
                } catch {
                    // Fall through to the public lookup
                }
            }
            return dependencies.api.getChat(`@${target.username}`, toTelegramApiAbortSignal(signal));
        }
    }
};

/** getChat for one target, with the ten-minute cache and one in-flight call */
const resolveChat = async (
    target: AvatarTarget,
    dependencies: AvatarDependencies,
    signal: AbortSignal
): Promise<AvatarChat> => {
    const key = avatarTargetKey(target);
    const now = (dependencies.now ?? Date.now)();
    const cached = cachedChats.get(key);
    if (cached !== undefined && cached.expiresAt > now) return cached.chat;

    const running = inflightChats.get(key);
    if (running !== undefined) return running;

    const promise = (async (): Promise<AvatarChat> => {
        try {
            const chat = await lookupChat(target, dependencies, signal);
            rememberChat(key, chat, now);
            return chat;
        } finally {
            inflightChats.delete(key);
        }
    })();
    inflightChats.set(key, promise);
    return promise;
};

const downloadAvatarBytes = async (
    dependencies: AvatarDependencies,
    fileId: string,
    signal: AbortSignal
): Promise<Buffer> => {
    if (dependencies.download !== undefined) return dependencies.download(fileId, signal);
    const { bytes } = await downloadTelegramFile({ api: dependencies.api }, fileId, signal);
    return bytes;
};

/**
 * Read one avatar. Every failure is a sentence the model can act on; nothing
 * here throws.
 */
export const resolveAvatar = async (
    target: AvatarTarget,
    options: { readonly view: AvatarView; readonly signal: AbortSignal },
    dependencies: AvatarDependencies
): Promise<AvatarOutcome> => {
    if (target.kind === 'bot' && (dependencies.botUserId ?? null) === null) {
        return { ok: false, error: '没有配置 BOT_USER_ID，取不到我的头像。' };
    }

    let chat: AvatarChat;
    try {
        chat = await resolveChat(target, dependencies, options.signal);
    } catch (error) {
        return { ok: false, error: failureMessage(target, error) };
    }

    if (chat.photo === undefined) return { ok: false, error: noAvatarMessage(target, chat) };
    const fileId = options.view === 'thumbnail' ? chat.photo.small_file_id : chat.photo.big_file_id;

    let data: Buffer;
    try {
        data = await downloadAvatarBytes(dependencies, fileId, options.signal);
    } catch (error) {
        return { ok: false, error: `取头像失败：${describeApiError(error).description}` };
    }

    const mimeType = sniffImageMime(data);
    if (mimeType === null) {
        return { ok: false, error: '头像文件不是可识别的图片格式（PNG/JPEG/WebP）。' };
    }

    return {
        ok: true,
        avatar: { label: avatarLabel(target, chat), data, mimeType, view: options.view },
    };
};
