/**
 * MiMo answers a moderation block with HTTP 200 and `finish_reason:
 * "content_filter"`, whose content is a fixed English sentence — the block looks
 * exactly like an ordinary reply. Left alone it gets posted into the chat as if
 * the bot had said it (seen in production 2026-09-22).
 *
 * The provider exposes no client-side switch for this: Gemini-style
 * `safety_settings` values and a `moderation` object are silently ignored
 * (verified 2026-09-22 — both parameters return a normal completion). The block
 * is also probabilistic, so there is nothing to turn off — the reply side has to
 * recognise it and fail legibly instead.
 */
import { AppError } from '../../shared/errors.js';

export const MIMO_CONTENT_FILTER_NOTICE =
    'The request was rejected because it was considered high risk';

const normalize = (text: string): string => text.trim().toLowerCase();

export const isMimoContentFilterFinishReason = (
    finishReason: string | null | undefined
): boolean => finishReason === 'content_filter';

export const isMimoContentFilterNotice = (text: string): boolean =>
    normalize(text) === normalize(MIMO_CONTENT_FILTER_NOTICE);

/**
 * True while `text` could still grow into the notice: the sentence may stream in
 * pieces, so a chunk is held back until it diverges (or turns out to be the
 * notice). Keeps the provider's raw line out of the chat either way.
 */
export const isMimoContentFilterNoticePrefix = (text: string): boolean => {
    const candidate = normalize(text);
    return candidate.length > 0 && normalize(MIMO_CONTENT_FILTER_NOTICE).startsWith(candidate);
};

/**
 * The one visible line for a blocked turn. The error path renders it as the
 * italic error line and offers the retry button, so the turn still ends cleanly.
 */
export const buildMimoContentFilterError = (): AppError =>
    new AppError('这条被 MiMo 的内容风控拦下了，点重试或 /model 换个模型再试', 'CONTENT_FILTER');
