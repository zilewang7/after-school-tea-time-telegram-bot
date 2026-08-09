/**
 * Inline keyboards for the generation commands, and the callback-data format
 * the runner and the menu both have to agree on.
 *
 * Its own file so the runner can build buttons without importing the menu and
 * the menu can parse them without importing the runner (which would be a cycle).
 */
import { InlineKeyboard } from 'grammy';

export const GENERATION_CALLBACK_PREFIX = 'gen:';

/**
 * `cancel` and `reroll` are keyed by job id; `retry` and `rewrite` by an id
 * from the action store, because both exist for moments when there is no job.
 */
export type GenerationAction = 'cancel' | 'reroll' | 'retry' | 'rewrite';

/** ⏹ on the placeholder while the job runs */
export const buildCancelButton = (jobId: string): InlineKeyboard =>
    new InlineKeyboard().text('⏹ 取消', `${GENERATION_CALLBACK_PREFIX}cancel:${jobId}`);

/** 🎲 on the finished result — same prompt and parameters, new seed */
export const buildRerollButton = (jobId: string): InlineKeyboard =>
    new InlineKeyboard().text('🎲 重掷', `${GENERATION_CALLBACK_PREFIX}reroll:${jobId}`);

/**
 * 🔄 on anything that failed. Retyping the whole command after a dropped
 * connection is the single most annoying thing about this flow, and the bot
 * already holds everything the attempt needs.
 */
export const buildRetryButton = (actionId: string): InlineKeyboard =>
    new InlineKeyboard().text('🔄 重试', `${GENERATION_CALLBACK_PREFIX}retry:${actionId}`);

/**
 * ✍️ on the storyboard `/vid` posts — plan the whole thing again from the
 * user's original idea. 🎲 only changes the seed, so this is the button for
 * "the storyboard itself missed the point".
 */
export const buildRewriteButton = (actionId: string): InlineKeyboard =>
    new InlineKeyboard().text('✍️ 重写分镜', `${GENERATION_CALLBACK_PREFIX}rewrite:${actionId}`);

export interface GenerationCallback {
    action: GenerationAction;
    /** A job id for cancel/reroll, an action-store id for retry/rewrite */
    id: string;
}

const isAction = (value: string): value is GenerationAction =>
    value === 'cancel' || value === 'reroll' || value === 'retry' || value === 'rewrite';

/** `gen:reroll:<id>` → its parts, or null when it isn't ours */
export const parseGenerationCallback = (data: string): GenerationCallback | null => {
    if (!data.startsWith(GENERATION_CALLBACK_PREFIX)) return null;
    const rest = data.slice(GENERATION_CALLBACK_PREFIX.length);
    const separator = rest.indexOf(':');
    if (separator === -1) return null;

    const action = rest.slice(0, separator);
    const id = rest.slice(separator + 1);
    if (!id) return null;
    if (!isAction(action)) return null;

    return { action, id };
};
