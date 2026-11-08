/**
 * Argument parsing for the two history tools.
 *
 * Kept apart from the tools so the date/limit/ref rules can be tested without
 * a fetch: everything here is a pure function of the raw JSON arguments and a
 * time zone. Errors are returned as model-facing sentences, not thrown.
 */
import { HISTORY_MAX_SEARCH_LIMIT } from '../../services/luoxu-history-service.js';

/**
 * How many hits one search returns when the model does not say. Kept at the
 * pre-existing 10: raising the ceiling must not quietly enlarge every reply.
 */
export const HISTORY_DEFAULT_LIMIT = 10;
/** Most hits one search may ask for (luoxu's ceiling) */
export const HISTORY_MAX_LIMIT = HISTORY_MAX_SEARCH_LIMIT;
export const HISTORY_DEFAULT_MINUTES = 10;
export const HISTORY_MAX_MINUTES = 120;
export const HISTORY_MAX_REFS = 10;
export const HISTORY_MAX_QUERY_CHARS = 100;
/** How long one history query may take, wall clock, before it is abandoned */
export const HISTORY_DEFAULT_TIME_ZONE = 'Asia/Shanghai';

export interface HistorySearchArgs {
    readonly query: string | null;
    readonly sender: string | null;
    readonly from: string | null;
    readonly to: string | null;
    readonly before: string | null;
    readonly limit: number;
    readonly scope: 'chat' | 'all';
}

export interface HistoryReadArgs {
    readonly refs: readonly string[];
    readonly around: string | null;
    readonly minutes: number;
    readonly folded: boolean;
}

export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const fail = (error: string): ParseResult<never> => ({ ok: false, error });

const asString = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const asInteger = (value: unknown): number | null =>
    typeof value === 'number' && Number.isInteger(value) ? value : null;

/**
 * `defaultScope` is `all` in the owner's private chat: that chat has no archive
 * of its own, so the model means "every archived group" unless it says otherwise.
 */
export const parseHistorySearchArgs = (
    raw: Readonly<Record<string, unknown>>,
    defaultScope: 'chat' | 'all' = 'chat'
): ParseResult<HistorySearchArgs> => {
    const query = asString(raw.query);
    if (query && Array.from(query).length > HISTORY_MAX_QUERY_CHARS) {
        return fail(`query 太长（上限 ${HISTORY_MAX_QUERY_CHARS} 字符）`);
    }
    const limitRaw = raw.limit === undefined ? HISTORY_DEFAULT_LIMIT : asInteger(raw.limit);
    if (limitRaw === null || limitRaw < 1 || limitRaw > HISTORY_MAX_LIMIT) {
        return fail(`limit 需要是 1–${HISTORY_MAX_LIMIT} 的整数`);
    }
    const scopeRaw = raw.scope === undefined ? defaultScope : asString(raw.scope);
    if (scopeRaw !== 'chat' && scopeRaw !== 'all') {
        return fail("scope 只能是 'chat'（本聊天）或 'all'（全部归档群，仅机主）");
    }
    return {
        ok: true,
        value: {
            query,
            sender: asString(raw.sender),
            from: asString(raw.from),
            to: asString(raw.to),
            before: asString(raw.before),
            limit: limitRaw,
            scope: scopeRaw,
        },
    };
};

export const parseHistoryReadArgs = (raw: Readonly<Record<string, unknown>>): ParseResult<HistoryReadArgs> => {
    const idsRaw = raw.ids;
    const refs: string[] = [];
    if (typeof idsRaw === 'string' && idsRaw.trim()) refs.push(idsRaw.trim());
    if (Array.isArray(idsRaw)) {
        for (const item of idsRaw) {
            const text = typeof item === 'string' ? item.trim() : '';
            if (text) refs.push(text);
        }
    }
    const around = asString(raw.around);
    if (refs.length === 0 && !around) {
        return fail('需要给 ids（读整条）或 around（读某条前后的对话）中的一个');
    }
    if (refs.length > 0 && around) {
        return fail('ids 与 around 只能给一个');
    }
    if (refs.length > HISTORY_MAX_REFS) {
        return fail(`一次最多读 ${HISTORY_MAX_REFS} 条`);
    }
    const minutesRaw = raw.minutes === undefined ? HISTORY_DEFAULT_MINUTES : asInteger(raw.minutes);
    if (minutesRaw === null || minutesRaw < 1 || minutesRaw > HISTORY_MAX_MINUTES) {
        return fail(`minutes 需要是 1–${HISTORY_MAX_MINUTES} 的整数`);
    }
    return {
        ok: true,
        value: {
            refs,
            around,
            minutes: minutesRaw,
            folded: raw.folded === true,
        },
    };
};

/** `#12` when the message is in this turn's context, `h3` when a tool showed it */
export type HistoryReference =
    | { readonly kind: 'number'; readonly h: number }
    | { readonly kind: 'context'; readonly number: number }
    | { readonly kind: 'link'; readonly channelId: number; readonly messageId: number };

const LINK_PATTERN = /^https?:\/\/t\.me\/c\/(\d+)\/(\d+)\/?$/;

/** Parse one `hN` / `#N` / t.me/c/… reference; null when none of those */
export const parseHistoryReference = (text: string): HistoryReference | null => {
    const trimmed = text.trim();
    const numbered = /^h(\d+)$/.exec(trimmed);
    if (numbered) return { kind: 'number', h: Number.parseInt(numbered[1] ?? '', 10) };
    const context = /^#(\d+)$/.exec(trimmed);
    if (context) return { kind: 'context', number: Number.parseInt(context[1] ?? '', 10) };
    const link = LINK_PATTERN.exec(trimmed);
    if (link) {
        return {
            kind: 'link',
            channelId: Number.parseInt(link[1] ?? '', 10),
            messageId: Number.parseInt(link[2] ?? '', 10),
        };
    }
    return null;
};

export const HISTORY_REF_HINT = '可用的引用形式：hN（本回复里出现过的编号）、#N（本轮上下文里的编号）、https://t.me/c/<群>/<消息>';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/;

/** Offset of one zone at one instant, in ms (positive east of UTC) */
const zoneOffsetMs = (utcMs: number, timeZone: string): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const get = (type: string): number => Number.parseInt(parts.find((part) => part.type === type)?.value ?? '0', 10);
    const wallClock = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return wallClock - utcMs;
};

/** A wall-clock time in `timeZone` → unix seconds */
export const zonedUnixSeconds = (
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    timeZone: string
): number => {
    const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
    const firstOffset = zoneOffsetMs(guess, timeZone);
    const instant = guess - firstOffset;
    const secondOffset = zoneOffsetMs(instant, timeZone);
    return Math.floor((secondOffset === firstOffset ? instant : guess - secondOffset) / 1000);
};

export interface ParsedDateRange {
    readonly start: number | null;
    readonly end: number | null;
    /** Why the input was rejected, when it was */
    readonly error: string | null;
}

/**
 * `from` / `to` accept `YYYY-MM-DD` (whole day) or `YYYY-MM-DD HH:mm`.
 * `to` is inclusive: a bare date means the end of that day.
 */
export const parseDateBound = (
    text: string | null,
    edge: 'start' | 'end',
    timeZone: string
): { readonly seconds: number | null; readonly error: string | null } => {
    if (!text) return { seconds: null, error: null };
    const match = DATE_PATTERN.exec(text.trim());
    if (!match) return { seconds: null, error: `时间格式不对：${text}（要 YYYY-MM-DD 或 YYYY-MM-DD HH:mm）` };
    const year = Number.parseInt(match[1] ?? '', 10);
    const month = Number.parseInt(match[2] ?? '', 10);
    const day = Number.parseInt(match[3] ?? '', 10);
    const hasTime = match[4] !== undefined;
    const hour = hasTime ? Number.parseInt(match[4] ?? '0', 10) : edge === 'end' ? 23 : 0;
    const minute = hasTime ? Number.parseInt(match[5] ?? '0', 10) : edge === 'end' ? 59 : 0;
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
        return { seconds: null, error: `时间不合法：${text}` };
    }
    return { seconds: zonedUnixSeconds(year, month, day, hour, minute, timeZone), error: null };
};
