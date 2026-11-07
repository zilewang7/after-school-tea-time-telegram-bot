/**
 * The last 50 reply errors, in memory for the panel's live status (design
 * §6.6). Gone on restart; reply_metrics keeps the durable record.
 */
import type { ErrorKind } from '../shared/error-kind.js';

export interface RecentReplyError {
    readonly at: Date;
    readonly chatId: number;
    readonly model: string;
    readonly errorKind: ErrorKind;
    /** <= 200 characters of the platform's error text */
    readonly errorSummary: string;
    readonly firstMessageId: number;
}

export const RECENT_REPLY_ERROR_CAPACITY = 50;

/** Oldest first; trimmed from the front once full */
const recentErrors: RecentReplyError[] = [];

export const pushRecentReplyError = (entry: RecentReplyError): void => {
    recentErrors.push(entry);
    if (recentErrors.length > RECENT_REPLY_ERROR_CAPACITY) {
        recentErrors.splice(0, recentErrors.length - RECENT_REPLY_ERROR_CAPACITY);
    }
};

/** Newest first */
export const listRecentReplyErrors = (): readonly RecentReplyError[] => [...recentErrors].reverse();
