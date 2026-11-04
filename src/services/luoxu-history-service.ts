/**
 * Read side of luoxu's message archive.
 *
 * luoxu indexes every message of a few groups into PostgreSQL + PGroonga, so
 * "what was said last month" is a query rather than a feature this bot has to
 * store: this service is the thin client for `/search`, `/messages` and
 * `/names`. It keeps no cache of its own — the per-reply history state does
 * that, because ids are only meaningful while one reply is being generated.
 *
 * Failures are typed instead of thrown as strings: each tool turns one kind
 * into one sentence for the model, and the model decides what to do next.
 *
 * luoxu is reached through the same base URL as the preview service
 * (`LUOXU_PREVIEW_URL`); chat ids are translated by `toLuoxuChannelId`.
 */

/** Why a history request could not be answered */
export type HistoryFailureKind =
    /** luoxu's query parser rejected the query (`()`, stray operators) */
    | 'bad-query'
    /** luoxu does not index this chat */
    | 'not-indexed'
    /** timeout, connection error, 5xx, unexpected payload */
    | 'unavailable';

export class HistoryRequestError extends Error {
    readonly kind: HistoryFailureKind;
    /** Human-readable cause, already safe to show the model */
    readonly detail: string;

    constructor(kind: HistoryFailureKind, detail: string) {
        super(detail);
        this.name = 'HistoryRequestError';
        this.kind = kind;
        this.detail = detail;
    }
}

/** One row of the full-text index */
export interface HistoryHit {
    readonly channelId: number;
    readonly messageId: number;
    /** Unix seconds, from luoxu's `t` */
    readonly timestamp: number;
    readonly fromId: number | null;
    readonly fromName: string;
    /** The whole indexed text, HTML-escaped; keyword spans only with a query */
    readonly html: string;
    readonly editedAt: number | null;
}

export interface HistorySearchOptions {
    /** null = every indexed group (owner-only cross-group scope) */
    readonly channelId: number | null;
    readonly query?: string | null;
    /** Exact ids to read; requires channelId */
    readonly ids?: readonly number[] | null;
    readonly senderId?: number | null;
    readonly start?: number | null;
    readonly end?: number | null;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
}

export interface HistorySearchOutcome {
    /** channelId → group title, for rendering cross-group hits */
    readonly groups: ReadonlyMap<number, string>;
    readonly hasMore: boolean;
    readonly hits: readonly HistoryHit[];
}

export interface HistorySender {
    readonly uid: number;
    readonly name: string;
}

/** One entity in Bot API shape, as luoxu reports it */
export interface HistoryRawEntity {
    readonly type: string;
    readonly offset: number;
    readonly length: number;
    readonly url?: string;
}

/** What kind of medium a message carries, as luoxu reports it */
export interface HistoryMedia {
    /** sticker / photo / video / animation / audio / document */
    readonly type: string;
    readonly mime: string | null;
    readonly size: number | null;
    readonly duration: number | null;
    /** A sticker's pack emoji (`alt`), the hint a client paints on the bubble */
    readonly stickerEmoji: string | null;
    readonly fileName: string | null;
    readonly voice: boolean;
}

export interface HistoryForward {
    readonly kind: string | null;
    readonly fromId: number | null;
    readonly fromName: string | null;
}

/** A message as Telegram has it right now (no index extras, no OCR) */
export interface HistoryRawMessage {
    readonly messageId: number;
    readonly senderId: number | null;
    readonly senderName: string;
    readonly senderIsBot: boolean;
    readonly text: string;
    readonly entities: readonly HistoryRawEntity[];
    readonly replyToId: number | null;
    readonly media: HistoryMedia | null;
    readonly forward: HistoryForward | null;
    /** Unix seconds */
    readonly date: number | null;
}

export interface HistoryService {
    readonly search: (options: HistorySearchOptions) => Promise<HistorySearchOutcome>;
    /** Name → candidates; luoxu keeps one row per uid, so duplicates are normal */
    readonly findSenders: (
        channelId: number,
        name: string,
        options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal }
    ) => Promise<readonly HistorySender[]>;
    /** Raw messages by id; deleted ids are simply absent */
    readonly messages: (
        channelId: number,
        ids: readonly number[],
        options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal }
    ) => Promise<readonly HistoryRawMessage[]>;
}

export const HISTORY_SEARCH_TIMEOUT_MS = 10_000;
export const HISTORY_MESSAGES_TIMEOUT_MS = 5_000;
export const HISTORY_NAMES_TIMEOUT_MS = 3_000;

const SEARCH_LIMIT = 50;

const requestSignal = (timeoutMs: number, signal?: AbortSignal): AbortSignal =>
    signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const numberOf = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

const stringOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const failureFor = (response: Response, detail: string): HistoryRequestError => {
    if (response.status === 400) return new HistoryRequestError('bad-query', detail);
    if (response.status === 404) return new HistoryRequestError('not-indexed', detail);
    return new HistoryRequestError('unavailable', `${detail}（HTTP ${response.status}）`);
};

const parseHit = (raw: unknown, fallbackChannelId: number | null): HistoryHit | null => {
    if (!isRecord(raw)) return null;
    const messageId = numberOf(raw.id);
    const timestamp = numberOf(raw.t);
    const html = stringOf(raw.html);
    if (messageId === null || timestamp === null || html === null) return null;
    return {
        channelId: numberOf(raw.group_id) ?? fallbackChannelId ?? 0,
        messageId,
        timestamp,
        fromId: numberOf(raw.from_id),
        fromName: stringOf(raw.from_name) ?? '',
        html,
        editedAt: numberOf(raw.edited),
    };
};

const parseGroups = (raw: unknown): Map<number, string> => {
    const groups = new Map<number, string>();
    if (!isRecord(raw)) return groups;
    for (const [key, value] of Object.entries(raw)) {
        const channelId = Number.parseInt(key, 10);
        if (!Number.isFinite(channelId)) continue;
        if (!Array.isArray(value)) continue;
        const title = stringOf(value[1]);
        groups.set(channelId, title ?? String(channelId));
    }
    return groups;
};

const parseMedia = (raw: unknown): HistoryMedia | null => {
    if (!isRecord(raw)) return null;
    const type = stringOf(raw.type);
    if (type === null) return null;
    return {
        type,
        mime: stringOf(raw.mime),
        size: numberOf(raw.size),
        duration: numberOf(raw.duration),
        stickerEmoji: stringOf(raw.sticker_emoji),
        fileName: stringOf(raw.file_name),
        voice: raw.voice === true,
    };
};

const parseForward = (raw: unknown): HistoryForward | null => {
    if (!isRecord(raw)) return null;
    return {
        kind: stringOf(raw.kind),
        fromId: numberOf(raw.from_id),
        fromName: stringOf(raw.from_name),
    };
};

const parseRawMessage = (raw: unknown): HistoryRawMessage | null => {
    if (!isRecord(raw)) return null;
    const messageId = numberOf(raw.id);
    if (messageId === null) return null;
    const entities: HistoryRawEntity[] = [];
    if (Array.isArray(raw.entities)) {
        for (const entity of raw.entities) {
            if (!isRecord(entity)) continue;
            const type = stringOf(entity.type);
            const offset = numberOf(entity.offset);
            const length = numberOf(entity.length);
            if (type === null || offset === null || length === null) continue;
            const url = stringOf(entity.url);
            entities.push(url === null ? { type, offset, length } : { type, offset, length, url });
        }
    }
    const replyTo = isRecord(raw.reply_to) ? numberOf(raw.reply_to.reply_to_msg_id) : null;
    return {
        messageId,
        senderId: numberOf(raw.sender_id),
        senderName: stringOf(raw.sender_name) ?? '',
        senderIsBot: raw.sender_is_bot === true,
        text: stringOf(raw.text) ?? '',
        entities,
        replyToId: numberOf(raw.reply_to) ?? replyTo,
        media: parseMedia(raw.media),
        forward: parseForward(raw.forward),
        date: numberOf(raw.date),
    };
};

export interface HistoryServiceOptions {
    /** luoxu base URL, e.g. http://luoxu-api:9008/luoxu; empty disables every call */
    readonly baseUrl: string;
    /** Test hook */
    readonly fetchImpl?: typeof fetch;
}

const buildSearchUrl = (baseUrl: string, options: HistorySearchOptions): string => {
    const params = new URLSearchParams();
    if (options.channelId !== null) params.set('g', String(options.channelId));
    if (options.ids && options.ids.length > 0) {
        params.set('ids', options.ids.slice(0, SEARCH_LIMIT).join(','));
    }
    const query = options.query?.trim();
    if (query) params.set('q', query);
    if (options.senderId) params.set('sender', String(options.senderId));
    if (options.start !== null && options.start !== undefined) params.set('start', String(options.start));
    if (options.end !== null && options.end !== undefined) params.set('end', String(options.end));
    return `${baseUrl}/search?${params.toString()}`;
};

export const createHistoryService = (options: HistoryServiceOptions): HistoryService => {
    const baseUrl = options.baseUrl.replace(/\/+$/, '');
    const doFetch = options.fetchImpl ?? fetch;

    const call = async (
        url: string,
        timeoutMs: number,
        signal: AbortSignal | undefined,
        what: string
    ): Promise<unknown> => {
        if (!baseUrl) throw new HistoryRequestError('unavailable', `${what}未配置（LUOXU_PREVIEW_URL 为空）`);
        let response: Response;
        try {
            response = await doFetch(url, { signal: requestSignal(timeoutMs, signal) });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new HistoryRequestError('unavailable', `${what}请求失败：${detail}`);
        }
        if (!response.ok) throw failureFor(response, `${what}被拒绝`);
        try {
            return (await response.json()) as unknown;
        } catch {
            throw new HistoryRequestError('unavailable', `${what}返回了无法解析的内容`);
        }
    };

    const search = async (searchOptions: HistorySearchOptions): Promise<HistorySearchOutcome> => {
        if (searchOptions.ids && searchOptions.ids.length > 0 && searchOptions.channelId === null) {
            throw new HistoryRequestError('bad-query', '按消息 id 读取必须指定聊天');
        }
        const url = buildSearchUrl(baseUrl, searchOptions);
        const payload = await call(
            url,
            searchOptions.timeoutMs ?? HISTORY_SEARCH_TIMEOUT_MS,
            searchOptions.signal,
            '检索'
        );
        if (!isRecord(payload) || !Array.isArray(payload.messages)) {
            throw new HistoryRequestError('unavailable', '检索返回了意料之外的格式');
        }
        const groups = parseGroups(payload.groupinfo);
        const hits: HistoryHit[] = [];
        for (const raw of payload.messages) {
            const hit = parseHit(raw, searchOptions.channelId);
            if (hit) hits.push(hit);
        }
        return { groups, hasMore: payload.has_more === true, hits };
    };

    const findSenders = async (
        channelId: number,
        name: string,
        callOptions: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}
    ): Promise<readonly HistorySender[]> => {
        const params = new URLSearchParams({ g: String(channelId), q: name });
        const payload = await call(
            `${baseUrl}/names?${params.toString()}`,
            callOptions.timeoutMs ?? HISTORY_NAMES_TIMEOUT_MS,
            callOptions.signal,
            '发言人解析'
        );
        if (!isRecord(payload) || !Array.isArray(payload.names)) return [];
        const senders: HistorySender[] = [];
        for (const item of payload.names) {
            if (!Array.isArray(item)) continue;
            const uid = numberOf(item[0]);
            const senderName = stringOf(item[1]);
            if (uid === null || senderName === null) continue;
            senders.push({ uid, name: senderName });
        }
        return senders;
    };

    const messages = async (
        channelId: number,
        ids: readonly number[],
        callOptions: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}
    ): Promise<readonly HistoryRawMessage[]> => {
        if (ids.length === 0) return [];
        const params = new URLSearchParams({ g: String(channelId), ids: ids.slice(0, SEARCH_LIMIT).join(',') });
        const payload = await call(
            `${baseUrl}/messages?${params.toString()}`,
            callOptions.timeoutMs ?? HISTORY_MESSAGES_TIMEOUT_MS,
            callOptions.signal,
            '读取原文'
        );
        if (!isRecord(payload) || !Array.isArray(payload.messages)) {
            throw new HistoryRequestError('unavailable', '读取原文返回了意料之外的格式');
        }
        const out: HistoryRawMessage[] = [];
        for (const raw of payload.messages) {
            const message = parseRawMessage(raw);
            if (message) out.push(message);
        }
        return out;
    };

    return { search, findSenders, messages };
};
