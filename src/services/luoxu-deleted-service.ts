/**
 * Deletion watcher: Telegram's Bot API never reports deletions, so the only
 * process that can see them is luoxu's MTProto user account. luoxu records
 * every deleted message it observes in its `deleted_messages` table and serves
 * the list from `GET /luoxu/deleted?since=…`; this watcher polls that list and
 * writes `telegram_messages.deletedAt`.
 *
 * The only effect on a reply is that context building adds a `[deleted]`
 * marker: the row keeps its text, media, link previews and reply edges, and a
 * message whose deletion was never observed stays exactly as before. Failures
 * (luoxu unconfigured, unreachable, 5xx, bad payload) change nothing and are
 * logged at most once per few minutes.
 *
 * The watcher runs on its own timer, never on the reply path. Cursor state is
 * in memory; a restart resumes from the newest mark already in the database
 * (or the 7-day message retention window when there is none), so a gap is
 * re-read instead of lost.
 */
import { Op, QueryTypes } from '@sequelize/core';
import { Message } from '../db/messageDTO.js';
import { sequelize } from '../db/config.js';
import { withBusyRetry } from '../db/busy-retry.js';
import { fromLuoxuChannelId } from './luoxu-channel-id.js';

/** How often the watcher asks luoxu for new deletions */
const POLL_INTERVAL_MS = 30_000;
/** A hung luoxu must not pile polls up; the watcher is best-effort anyway */
const REQUEST_TIMEOUT_MS = 10_000;
/** `deleted` rows per request (luoxu caps it at 1000) */
const PAGE_LIMIT = 1000;
/** A single poll never walks more than this many pages */
const MAX_PAGES_PER_POLL = 10;
/** Messages live 7 days; deletions older than that cannot be marked anymore */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Throttle for the "luoxu unavailable" log so an outage is one line, not an alarm */
const ERROR_LOG_INTERVAL_MS = 5 * 60 * 1000;

interface DeletedRow {
    /** luoxu channel id (bare, not the Bot API chat id) */
    readonly channelId: number;
    readonly messageId: number;
    /** Unix seconds, as luoxu reports it */
    readonly deletedAt: number;
}

interface DeletedPage {
    readonly rows: readonly DeletedRow[];
    readonly hasMore: boolean;
}

/**
 * Unix seconds of the newest mark already in the database, or null. The whole
 * watcher speaks seconds (that is what `/deleted`'s `since` and `t` use), so
 * the stored DATETIME is converted here, not at every comparison.
 */
const latestMarkedAt = async (): Promise<number | null> => {
    const rows = await sequelize.query<{ latest: string | null }>(
        'SELECT MAX(deletedAt) AS latest FROM telegram_messages',
        { type: QueryTypes.SELECT }
    );
    const latest = rows[0]?.latest ?? null;
    if (latest === null) return null;
    const parsed = Date.parse(latest);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
};

const luoxuBaseUrl = (): string => process.env.LUOXU_PREVIEW_URL ?? '';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const numberOf = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Parse one `{g,id,t}` row; anything malformed is dropped rather than trusted */
const parseDeletedRow = (raw: unknown): DeletedRow | null => {
    if (!isRecord(raw)) return null;
    const channelId = numberOf(raw.g);
    const messageId = numberOf(raw.id);
    const deletedAt = numberOf(raw.t);
    if (channelId === null || messageId === null || deletedAt === null) return null;
    return { channelId, messageId, deletedAt };
};

const parsePage = (payload: unknown): DeletedPage | null => {
    if (!isRecord(payload) || !Array.isArray(payload.deleted)) return null;
    const rows: DeletedRow[] = [];
    for (const raw of payload.deleted) {
        const row = parseDeletedRow(raw);
        if (row !== null) rows.push(row);
    }
    return { rows, hasMore: payload.has_more === true };
};

const fetchPage = async (baseUrl: string, since: number): Promise<DeletedPage> => {
    const response = await fetch(
        `${baseUrl}/deleted?since=${Math.floor(since)}&limit=${PAGE_LIMIT}`,
        { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
    );
    if (!response.ok) {
        throw new Error(`luoxu /deleted HTTP ${response.status}`);
    }
    const page = parsePage(await response.json());
    if (page === null) {
        throw new Error('luoxu /deleted returned an unexpected payload');
    }
    return page;
};

/** Write one page's marks: one UPDATE per (chat, deletion time) */
const markDeletedRows = async (rows: readonly DeletedRow[]): Promise<number> => {
    // chatId → (deletion time in unix seconds → message ids), because one
    // UPDATE carries one timestamp. luoxu reports a batch deletion with one
    // time, so a page usually needs a single statement per chat.
    const byChat = new Map<number, Map<number, number[]>>();
    for (const row of rows) {
        const chatId = fromLuoxuChannelId(row.channelId);
        let byTime = byChat.get(chatId);
        if (byTime === undefined) {
            byTime = new Map<number, number[]>();
            byChat.set(chatId, byTime);
        }
        const ids = byTime.get(row.deletedAt);
        if (ids === undefined) {
            byTime.set(row.deletedAt, [row.messageId]);
        } else {
            ids.push(row.messageId);
        }
    }

    let marked = 0;
    for (const [chatId, byTime] of byChat) {
        for (const [deletedAtSeconds, ids] of byTime) {
            const [affected] = await withBusyRetry(
                () => Message.update(
                    { deletedAt: new Date(deletedAtSeconds * 1000) },
                    {
                        where: {
                            chatId,
                            messageId: { [Op.in]: ids },
                            // Never overwrite a known deletion: the first observation wins
                            deletedAt: { [Op.is]: null },
                        },
                    }
                ),
                `mark deleted messages in chat ${chatId}`
            );
            marked += affected;
        }
    }
    return marked;
};

/** Cursor of the newest row read; a deleted message is never un-deleted */
let cursor: number | null = null;
let pollInFlight = false;
let lastErrorAt = 0;
let timer: NodeJS.Timeout | null = null;

const reportFailure = (error: unknown): void => {
    const now = Date.now();
    if (now - lastErrorAt < ERROR_LOG_INTERVAL_MS) return;
    lastErrorAt = now;
    console.warn(
        '[luoxu-deleted] polling failed:',
        error instanceof Error ? error.message : error
    );
};

/**
 * Read every page available after `since` (default: the watcher's cursor),
 * mark matching rows and return the new cursor. Never throws; a failed request
 * leaves the cursor where it was so the next tick retries.
 */
export const pollDeletedMessagesOnce = async (since?: number): Promise<number> => {
    const baseUrl = luoxuBaseUrl();
    if (baseUrl === '') return cursor ?? 0;

    let at = since ?? cursor;
    if (at === null) {
        const latest = await latestMarkedAt();
        at = latest === null ? Math.floor((Date.now() - RETENTION_MS) / 1000) : latest;
    }

    for (let page = 0; page < MAX_PAGES_PER_POLL; page += 1) {
        let fetched: DeletedPage;
        try {
            fetched = await fetchPage(baseUrl, at);
        } catch (error) {
            reportFailure(error);
            break;
        }
        if (fetched.rows.length === 0) break;

        try {
            const marked = await markDeletedRows(fetched.rows);
            if (marked > 0) {
                console.log(`[luoxu-deleted] marked ${marked} deleted message(s)`);
            }
        } catch (error) {
            reportFailure(error);
            break;
        }

        for (const row of fetched.rows) {
            if (at === null || row.deletedAt > at) at = row.deletedAt;
        }
        cursor = at;
        if (!fetched.hasMore) break;
    }

    if (cursor === null) cursor = at;
    return cursor;
};

/** Test hook: forget the cursor/timer and the error throttle */
export const resetDeletedMessageWatch = (): void => {
    if (timer !== null) {
        clearInterval(timer);
        timer = null;
    }
    cursor = null;
    pollInFlight = false;
    lastErrorAt = 0;
};

/**
 * Start the 30s watcher. No-op when luoxu is not configured. The interval does
 * not keep the process alive (the bot has its own long-lived handles).
 */
export const startDeletedMessageWatch = (): void => {
    if (luoxuBaseUrl() === '' || timer !== null) return;

    const tick = (): void => {
        if (pollInFlight) return;
        pollInFlight = true;
        void pollDeletedMessagesOnce()
            .catch((error: unknown) => reportFailure(error))
            .finally(() => {
                pollInFlight = false;
            });
    };

    // First pass soon after startup (a pending listen does not block anything)
    const firstTick = setTimeout(tick, 5_000);
    firstTick.unref?.();
    timer = setInterval(tick, POLL_INTERVAL_MS);
    timer.unref?.();
    console.log('[luoxu-deleted] watching Telegram deletions from luoxu');
};
