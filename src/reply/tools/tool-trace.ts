/**
 * Display traces of the reply tools: what one call shows in the Tools block's
 * per-call log (design 2026-1119-1835).
 *
 * A handler knows the counts, ids and sizes the model asked for; the collector
 * only sees the raw arguments and the result text. These helpers build the two
 * short strings a handler hands back, so every tool reads the same way and no
 * content, url query or file body ever reaches the log.
 */
import { CURRENT_WORKSPACE_TOKEN } from '../workspace/workspace-state.js';

/** Separator between the parts of one argument or result summary */
const PART_SEPARATOR = ' · ';

/** Whitespace inside a one-line summary: collapsed, so a value cannot break the line */
export const traceText = (value: string): string => value.replace(/\s+/g, ' ').trim();

/** Cut by code points, so an emoji is never split in half */
const excerpt = (text: string, maxChars: number): string => {
    const characters = Array.from(text);
    return characters.length <= maxChars
        ? text
        : `${characters.slice(0, Math.max(1, maxChars - 1)).join('')}…`;
};

/** A text value as the log shows it: collapsed, in 「」, cut */
export const traceQuote = (value: string, maxChars = 48): string =>
    `「${excerpt(traceText(value), maxChars)}」`;

/** Join the parts of an argument/result summary, dropping the empty ones */
export const traceParts = (...parts: readonly (string | null | undefined)[]): string =>
    parts.filter((part): part is string => part !== undefined && part !== null && part !== '').join(PART_SEPARATOR);

/**
 * `812KB`, `3.4KB`, `1.2MB`: compact enough for a log line, unlike the
 * model-facing `formatBytes` (`12.4 KB`).
 */
export const traceBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes}B`;
    const kilobytes = bytes / 1024;
    if (kilobytes < 100) return `${kilobytes.toFixed(1).replace(/\.0$/, '')}KB`;
    if (bytes < 1024 * 1024) return `${Math.round(kilobytes)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
};

/** `128 字`, `12.3K 字` */
export const traceChars = (chars: number): string =>
    chars < 1000 ? `${chars} 字` : `${(chars / 1000).toFixed(1)}K 字`;

/** host + pathname of a url; never the query or hash (they can carry a signature) */
export const traceUrl = (raw: string): string => {
    try {
        const url = new URL(raw);
        const host = url.hostname.replace(/^www\./, '');
        return url.pathname === '/' ? host : `${host}${url.pathname}`;
    } catch {
        return traceText(raw);
    }
};

/** A message/archive reference: a link only by its host + path, anything else as-is */
export const traceRef = (value: string): string =>
    /^https?:\/\//i.test(value.trim()) ? traceUrl(value.trim()) : traceText(value);

/** `2026-11-01~11-19`: a date range, the second year dropped when it is the same */
export const traceDateRange = (from: string | null, to: string | null): string | null => {
    if (from === null && to === null) return null;
    const left = from === null ? '' : traceText(from);
    const right = to === null ? '' : traceText(to);
    const sameYear = /^\d{4}-/.test(right) && right.slice(0, 4) === left.slice(0, 4);
    return `${left}~${sameYear ? right.slice(5) : right}`;
};

/** A workspace path prefixed with its token when the call addresses another conversation */
export const traceWorkspacePath = (token: string, path: string): string => {
    if (token === CURRENT_WORKSPACE_TOKEN) return path;
    return path === '' ? token : `${token} ${path}`;
};
