/**
 * What the two public entries read (design §5.3/§5.4).
 *
 * Read order: the in-memory stream first (generating, or finished within the last
 * two hours), then the version's stored `thinkingText` (the process restarted, or
 * the link is old), otherwise the thinking is gone. A row whose version was never
 * stored means the process died mid-generation — the page reports it as
 * interrupted rather than pretending the thinking was empty (design §9).
 */
import { findBotResponseInChat } from '../../db/queries/context-queries.js';
import type { ResponseVersion } from '../../db/index.js';
import { isShareToken } from '../share/token.js';
import { thinkingAttemptKeyOf } from './thinking-link-service.js';
import { thinkingStream } from './thinking-stream.js';
import { findThinkingLinkByToken } from './thinking-store.js';
import type {
    PublicThinkingResponse,
    ThinkingDocument,
    ThinkingLinkRow,
    ThinkingStatus,
} from './thinking-types.js';

/** A trimmed non-empty string, else null (rows can carry empty strings) */
const textOrNull = (value: string | null | undefined): string | null => {
    if (value === null || value === undefined) return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : value;
};

const storedVersionOf = async (row: ThinkingLinkRow): Promise<ResponseVersion | null> => {
    const response = await findBotResponseInChat(row.chatId, row.firstMessageId);
    if (response === null) return null;
    return response.getVersions().find((version) => version.versionId === row.versionId) ?? null;
};

const modelOf = (row: ThinkingLinkRow, version: ResponseVersion | null): string | null =>
    textOrNull(row.model) ?? textOrNull(version?.model ?? null);

const documentOf = (
    row: ThinkingLinkRow,
    live: { text: string; done: boolean } | null,
    version: ResponseVersion | null
): ThinkingDocument => {
    const model = modelOf(row, version);
    const errorMessage = textOrNull(version?.errorMessage ?? null);
    if (live !== null) {
        const status: ThinkingStatus = live.done ? 'done' : 'generating';
        return {
            row,
            model,
            createdAt: row.createdAt,
            done: live.done,
            status,
            // An error only makes sense once the stream has ended: while it is
            // still running the version (and its error line) does not exist yet
            errorMessage: live.done ? errorMessage : null,
            text: live.text,
        };
    }
    if (version === null) {
        return {
            row,
            model,
            createdAt: row.createdAt,
            done: true,
            status: 'interrupted',
            errorMessage: null,
            text: '',
        };
    }
    const text = version.thinkingText ?? '';
    return {
        row,
        model,
        createdAt: row.createdAt,
        done: true,
        status: text === '' ? 'unavailable' : 'done',
        errorMessage,
        text,
    };
};

/** The current state behind a token; null for a malformed or unknown token */
export const loadThinkingDocument = async (token: string): Promise<ThinkingDocument | null> => {
    if (!isShareToken(token)) return null;
    const row = await findThinkingLinkByToken(token);
    if (row === null) return null;
    const live = thinkingStream.read(thinkingAttemptKeyOf(row));
    // While the stream runs the version does not exist yet; otherwise its stored
    // text (and error line) is the authoritative source
    const version = live === null || live.done ? await storedVersionOf(row) : null;
    return documentOf(row, live, version);
};

/** The `after` query parameter of one poll */
export type ThinkingAfter = { kind: 'absent' } | { kind: 'offset'; value: number } | { kind: 'invalid' };

/** Parse `?after=N`; missing is the full read, anything not a non-negative integer is invalid */
export const parseThinkingAfter = (raw: string | undefined): ThinkingAfter => {
    if (raw === undefined) return { kind: 'absent' };
    if (raw.trim() === '') return { kind: 'invalid' };
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) return { kind: 'invalid' };
    return { kind: 'offset', value };
};

/**
 * The public JSON of one poll. Without `after` the answer carries the whole text;
 * with an in-range `after` only the increment is sent, so a 200k-character
 * thinking is not re-uploaded every 700ms. An out-of-range or malformed `after`
 * sets `reset`, and the caller replaces its text with the returned full one.
 */
export const toPublicThinkingResponse = (
    document: ThinkingDocument,
    after: ThinkingAfter
): PublicThinkingResponse => {
    const full = document.text;
    const base = {
        token: document.row.token,
        model: document.model,
        createdAt: document.createdAt,
        done: document.done,
        status: document.status,
        errorMessage: document.errorMessage,
        next: full.length,
    };
    if (after.kind === 'absent') return { ...base, text: full };
    if (after.kind === 'invalid' || after.value > full.length) {
        return { ...base, text: full, reset: true };
    }
    return { ...base, text: '', delta: full.slice(after.value) };
};
