/**
 * Request parsing shared by the routes: path ids, query integers and JSON
 * bodies. Every failure is a 400 `invalid`.
 */
import type { PanelContext } from './context.js';
import { PANEL_MESSAGES, PanelError } from './errors.js';
import { isJsonRecord, parseJson, type JsonRecord } from './json.js';

const CHAT_ID_PATTERN = /^-?\d{1,20}$/;
const POSITIVE_INTEGER_PATTERN = /^\d{1,15}$/;

export const invalid = (message: string): PanelError => new PanelError('invalid', message);

/** A Telegram chat id from a path or query parameter */
export const parseChatId = (raw: string | undefined): number => {
    if (raw === undefined || !CHAT_ID_PATTERN.test(raw)) throw invalid(PANEL_MESSAGES.invalidChatId);
    const chatId = Number(raw);
    if (!Number.isSafeInteger(chatId) || chatId === 0) throw invalid(PANEL_MESSAGES.invalidChatId);
    return chatId;
};

/** An optional positive integer query parameter within [1, max] */
export const parseOptionalPositiveInteger = (
    raw: string | undefined,
    name: string,
    max: number = Number.MAX_SAFE_INTEGER
): number | undefined => {
    if (raw === undefined || raw === '') return undefined;
    if (!POSITIVE_INTEGER_PATTERN.test(raw)) throw invalid(`${name} 必须是正整数`);
    const value = Number(raw);
    if (value < 1 || value > max) throw invalid(`${name} 必须在 1 到 ${max} 之间`);
    return value;
};

/**
 * The body as a JSON object. The body limit's own error passes through (it
 * becomes a 413); anything that is not a JSON object is a 400.
 */
export const readJsonObject = async (context: PanelContext): Promise<JsonRecord> => {
    const text = await context.req.text();
    const parsed = parseJson(text);
    if (!isJsonRecord(parsed)) throw invalid(PANEL_MESSAGES.invalidJson);
    return parsed;
};

/** Refuse keys outside `allowed`; require at least one of `required` when given */
export const checkBodyKeys = (
    body: JsonRecord,
    allowed: ReadonlySet<string>,
    required: readonly string[] = []
): void => {
    // Not echoed: the message never repeats request data
    if (Object.keys(body).some((key) => !allowed.has(key))) throw invalid('请求体包含不支持的字段');
    if (required.length > 0 && !required.some((key) => Object.hasOwn(body, key))) {
        throw invalid(`至少需要一个字段：${required.join(', ')}`);
    }
};
