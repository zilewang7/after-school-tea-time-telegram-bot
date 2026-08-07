/**
 * Inline keyboards for the pic commands, and the callback-data format the
 * runner and the menu both have to agree on.
 *
 * Its own file so the runner can build buttons without importing the menu and
 * the menu can parse them without importing the runner (which would be a cycle).
 */
import { InlineKeyboard } from 'grammy';

export const PIC_CALLBACK_PREFIX = 'pic:';

export type PicAction = 'cancel' | 'reroll';

/** ⏹ on the placeholder while the job runs */
export const buildCancelButton = (jobId: string): InlineKeyboard =>
    new InlineKeyboard().text('⏹ 取消', `${PIC_CALLBACK_PREFIX}cancel:${jobId}`);

/** 🎲 on the finished picture — same parameters, new seed */
export const buildRerollButton = (jobId: string): InlineKeyboard =>
    new InlineKeyboard().text('🎲 重掷', `${PIC_CALLBACK_PREFIX}reroll:${jobId}`);

export interface PicCallback {
    action: PicAction;
    jobId: string;
}

/** `pic:reroll:<jobId>` → its parts, or null when it isn't ours */
export const parsePicCallback = (data: string): PicCallback | null => {
    if (!data.startsWith(PIC_CALLBACK_PREFIX)) return null;
    const rest = data.slice(PIC_CALLBACK_PREFIX.length);
    const separator = rest.indexOf(':');
    if (separator === -1) return null;

    const action = rest.slice(0, separator);
    const jobId = rest.slice(separator + 1);
    if (!jobId) return null;
    if (action !== 'cancel' && action !== 'reroll') return null;

    return { action, jobId };
};
