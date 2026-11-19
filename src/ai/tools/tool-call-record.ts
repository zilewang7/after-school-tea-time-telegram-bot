/**
 * How one executed tool call reads in the Tools block's per-call log
 * (design 2026-1119-1835 §3.2, §4.5, §4.6, §13.3).
 *
 * The handler usually knows what only it knows (hit counts, candidate ids,
 * sizes) and writes a display trace on its result. Everything else — MCP tools,
 * unknown tools, tools that gained no trace yet — gets a generic summary here:
 * a whitelist of argument keys, URLs reduced to host + path, a result summary
 * from the content. Nothing in this module throws: a malformed argument JSON
 * must never end the tool round, so even that falls back to the raw text.
 */
import type { AgentToolCallRecord } from '../types.js';
import {
    TOOL_LOG_ARGUMENT_MAX_CHARS,
    TOOL_LOG_RESULT_MAX_CHARS,
    truncateCodePoints,
} from '../../shared/tool-log.js';
import type { ToolCall, ToolResult } from './tool-types.js';

/** Longest failure reason the log shows (the renderer adds 「失败：」 in front) */
const FAILURE_REASON_MAX_CHARS = 36;

/** Longest value shown next to its key, or as one item of an array */
const SCALAR_MAX_CHARS = 20;

/**
 * Argument keys that identify a call; the first present one is shown without
 * its key, in this order (most specific first).
 */
const PRIMARY_ARGUMENT_KEYS = [
    'query',
    'q',
    'search',
    'keyword',
    'keywords',
    'question',
    'url',
    'uri',
    'link',
    'libraryId',
    'library_id',
    'libraryName',
    'library_name',
    'topic',
    'path',
    'file',
    'filename',
    'file_name',
    'id',
    'ids',
    'title',
    'name',
    'prompt',
] as const;

/** Filter keys shown after the primary one, at most two, as `key=value` */
const SECONDARY_ARGUMENT_KEYS = [
    'sender',
    'from',
    'to',
    'before',
    'limit',
    'scope',
    'mode',
    'view',
    'count',
    'offset',
    'kind',
    'status',
    'language',
    'time_range',
    'pageno',
    'engines',
    'format',
] as const;

/** Keys whose value is never shown: body text, binaries and credentials */
const HIDDEN_KEYS: ReadonlySet<string> = new Set([
    'content',
    'text',
    'body',
    'html',
    'markdown',
    'md',
    'code',
    'source',
    'data',
    'base64',
    'binary',
    'bytes',
    'surface',
    'old_string',
    'oldstring',
    'new_string',
    'newstring',
    'image',
    'images',
    'files',
    'headers',
    'header',
]);

/** Any key that names a credential, whatever the tool's schema calls it */
const SECRET_KEY = /(token|secret|password|passwd|api_?key|auth|cookie|credential|signature|session)/i;

/** Values this long without a space read as a key, not as text: hide them */
const SECRET_VALUE_MIN_CHARS = 40;

/** Keys whose value is a URL even when the scheme is missing */
const URL_ARGUMENT_KEYS: ReadonlySet<string> = new Set(['url', 'uri', 'link']);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isHiddenKey = (key: string): boolean =>
    HIDDEN_KEYS.has(key.toLowerCase()) || SECRET_KEY.test(key);

/** A value with nothing to show: absent, empty, or an empty collection */
const isPresent = (value: unknown): boolean =>
    value !== undefined &&
    value !== null &&
    value !== '' &&
    !(Array.isArray(value) && value.length === 0);

/** One line: no newline, no run of whitespace */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

const codePointLength = (text: string): number => Array.from(text).length;

/** `host/path` of a URL, its query and hash dropped (they may hold tokens) */
const urlDisplay = (text: string): string =>
    text
        .trim()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
        .replace(/^\/\//, '')
        .split(/[?#]/)[0] ?? '';

/** A value this long without a space reads like a credential, not like text */
const looksLikeSecret = (text: string): boolean =>
    codePointLength(text) >= SECRET_VALUE_MIN_CHARS && !/\s/.test(text);

/**
 * Whether a plain string is an id/path/number/domain (shown as is) rather than
 * model or user text (wrapped in 「」). Hyphens are text: `k-on` is a search
 * phrase, not an identifier; a real id/date/version carries a digit anyway.
 */
const isIdentifierLike = (text: string): boolean => /[/\\.#:@_%]/.test(text) || /\d/.test(text);

/** One string value: collapsed, URLs reduced, credential-looking values hidden */
const compactString = (text: string, maxChars: number): string => {
    const collapsed = oneLine(text);
    if (collapsed === '') return '';
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(collapsed) || collapsed.startsWith('//')) {
        return truncateCodePoints(urlDisplay(collapsed), maxChars);
    }
    if (looksLikeSecret(collapsed)) return '…';
    return truncateCodePoints(collapsed, maxChars);
};

/** One item of an array, or one scalar of an object: never a nested dump */
const compactItem = (value: unknown): string => {
    if (typeof value === 'string') return compactString(value, SCALAR_MAX_CHARS);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return `[${value.length} 项]`;
    if (isRecord(value)) return compactObject(value);
    return '';
};

/** An object is never recursed into: one whitelisted scalar, or its field count */
const compactObject = (value: Readonly<Record<string, unknown>>): string => {
    for (const key of PRIMARY_ARGUMENT_KEYS) {
        if (!isPresent(value[key])) continue;
        const item = value[key];
        if (typeof item === 'string') return compactString(item, SCALAR_MAX_CHARS);
        if (typeof item === 'number' || typeof item === 'boolean') return String(item);
        break;
    }
    return `[${Object.keys(value).length} 字段]`;
};

/** An array: its first two items, then how many more there were */
const compactArray = (value: readonly unknown[]): string => {
    const shown = value
        .slice(0, 2)
        .map(compactItem)
        .filter((item) => item !== '');
    const more = value.length - Math.min(value.length, 2);
    const joined = shown.join('、');
    return more > 0 ? `${joined} +${more}` : joined;
};

/** A value shown without its key: numbers, booleans, arrays and objects */
const compactUnquoted = (value: unknown): string => {
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return compactArray(value);
    if (isRecord(value)) return compactObject(value);
    return '';
};

/** The primary value: quoted text, or an id/path/number/domain as is */
const primaryValueOf = (key: string, value: unknown): string => {
    if (typeof value !== 'string') return compactUnquoted(value);
    const collapsed = oneLine(value);
    if (collapsed === '') return '';
    if (URL_ARGUMENT_KEYS.has(key)) {
        return truncateCodePoints(urlDisplay(collapsed), TOOL_LOG_ARGUMENT_MAX_CHARS);
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(collapsed) || collapsed.startsWith('//')) {
        return truncateCodePoints(urlDisplay(collapsed), TOOL_LOG_ARGUMENT_MAX_CHARS);
    }
    if (looksLikeSecret(collapsed)) return '…';
    if (isIdentifierLike(collapsed)) return truncateCodePoints(collapsed, TOOL_LOG_ARGUMENT_MAX_CHARS);
    // Cut the content before wrapping: a half 「」 is never shown
    return `「${truncateCodePoints(collapsed, TOOL_LOG_ARGUMENT_MAX_CHARS - 2)}」`;
};

/** The value of one secondary key, never quoted */
const secondaryValueOf = (value: unknown): string => {
    if (typeof value === 'string') return compactString(value, SCALAR_MAX_CHARS);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return compactArray(value);
    if (isRecord(value)) return compactObject(value);
    return '';
};

/**
 * The argument summary: the primary key's value, then up to two `key=value`
 * filters, each added only while the line stays inside its budget. Without a
 * primary key the filters still show; without any of them, nothing does.
 */
const argumentSummaryOf = (args: Readonly<Record<string, unknown>>): string => {
    const primaryKey = PRIMARY_ARGUMENT_KEYS.find(
        (key) => isPresent(args[key]) && !isHiddenKey(key)
    );
    const primary = primaryKey === undefined ? '' : primaryValueOf(primaryKey, args[primaryKey]);
    const parts: string[] = primary === '' ? [] : [primary];
    let secondaryCount = 0;
    for (const key of SECONDARY_ARGUMENT_KEYS) {
        if (secondaryCount >= 2) break;
        if (!isPresent(args[key]) || isHiddenKey(key)) continue;
        const value = secondaryValueOf(args[key]);
        if (value === '') continue;
        const candidate = `${key}=${value}`;
        const line = [...parts, candidate].join(' · ');
        if (codePointLength(line) > TOOL_LOG_ARGUMENT_MAX_CHARS) continue;
        parts.push(candidate);
        secondaryCount++;
    }
    return truncateCodePoints(parts.join(' · '), TOOL_LOG_ARGUMENT_MAX_CHARS);
};

/** The arguments as JSON, or null when the model produced something that is not an object */
const parseArguments = (argumentsJson: string): Readonly<Record<string, unknown>> | null => {
    try {
        const parsed: unknown = JSON.parse(argumentsJson);
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

/**
 * The argument summary, preferring the handler's display trace. A malformed
 * argument JSON falls back to its raw text, truncated; it never throws.
 */
const argumentOf = (call: ToolCall, trace: ToolResult['trace']): string => {
    if (trace?.argument !== undefined) {
        return truncateCodePoints(oneLine(trace.argument), TOOL_LOG_ARGUMENT_MAX_CHARS);
    }
    const args = parseArguments(call.argumentsJson);
    if (args === null) {
        return truncateCodePoints(oneLine(call.argumentsJson), TOOL_LOG_ARGUMENT_MAX_CHARS);
    }
    return argumentSummaryOf(args);
};

/** The first sentence of an error, without its terminal punctuation */
const failureReasonOf = (content: string): string => {
    const collapsed = oneLine(content);
    if (collapsed === '') return '';
    const sentence = collapsed.split(/[。！？!?]/)[0] ?? collapsed;
    return sentence.replace(/[。．.！!？?；;：:]+$/u, '').trim();
};

/** `1.2K 字` from 1000 up, `1234 字` below */
const characterCountLine = (chars: number): string =>
    chars >= 1000 ? `${Math.round(chars / 100) / 10}K 字` : `${chars} 字`;

/**
 * The result summary, preferring the handler's display trace. Without one it
 * counts links, states the size, or repeats the error's first sentence.
 */
const resultOf = (result: ToolResult): string => {
    if (result.trace?.result !== undefined) {
        return truncateCodePoints(oneLine(result.trace.result), TOOL_LOG_RESULT_MAX_CHARS);
    }
    const content = result.content.trim();
    if (result.isError) {
        return truncateCodePoints(failureReasonOf(content), FAILURE_REASON_MAX_CHARS);
    }
    if (content === '') return '无内容';
    const linkCount = (content.match(/https?:\/\//g) ?? []).length;
    if (linkCount > 0) return `${linkCount} 条链接`;
    return characterCountLine(codePointLength(content));
};

/**
 * The per-call record of one executed call: the handler's trace when it wrote
 * one, the generic summary otherwise. Built by `runToolRound` for every call
 * the round offered, in call order.
 */
export const buildToolCallRecord = (
    call: ToolCall,
    result: ToolResult,
    durationMs: number
): AgentToolCallRecord => {
    const argument = argumentOf(call, result.trace);
    const outcome = resultOf(result);
    return {
        name: call.name,
        ...(argument === '' ? {} : { argument }),
        ...(outcome === '' ? {} : { result: outcome }),
        ...(result.isError ? { failed: true } : {}),
        ms: Math.max(0, Math.round(durationMs)),
    };
};
