/**
 * Which of the candidate messages a `/chat` actually attaches.
 *
 * Pure, so the rules the help text promises can be asserted offline. Each rule
 * below fixes a way the old inline version broke that promise: it filtered by
 * the *sender's* name for `-s`, let one person too many through `-N`, truncated
 * to the requested count before filtering rather than after, and spent slots on
 * rows that carry no content of their own (the command message itself and
 * media-group sub-images).
 */
import { match } from 'ts-pattern';
import type { SequentialSelection, UserScope } from './chat-command-parser.js';

/** One candidate row, projected without the media blob */
export interface CandidateMessage {
    messageId: number;
    userName: string;
    text: string | null;
}

/** A candidate for `/chat r`, whose selection is driven by timestamps */
export interface RecentCandidate extends CandidateMessage {
    date: Date;
}

export interface RecentSelectionOptions {
    userScope: UserScope;
    commandMessageId: number;
    /** Date of the reply target when there is one: the first gap is measured from it */
    anchorDate: Date | null;
    /** Silent cap: more than this keeps only the messages closest to the anchor */
    maxMessages: number;
}

/** Two messages further apart than this belong to different bursts of conversation */
export const RECENT_GAP_MS = 20 * 60 * 1000;

/** Media-group members whose media rides on the group's first message */
const SUB_IMAGE_PATTERN = /sub image of \[\w+\]/;

const carriesOwnContent = (row: CandidateMessage, commandMessageId: number): boolean =>
    row.messageId !== commandMessageId && !(row.text && SUB_IMAGE_PATTERN.test(row.text));

const matchesUserScope = (row: CandidateMessage, userScope: UserScope): boolean =>
    userScope.type !== 'named' || userScope.names.includes(row.userName);

/** Keep messages until `limit` distinct people have been seen, in the given order */
const withinPeopleLimit = <T extends CandidateMessage>(rows: T[], limit: number): T[] => {
    const seenUsers = new Set<string>();
    return rows.filter((row) => {
        if (seenUsers.has(row.userName)) return true;
        if (seenUsers.size >= limit) return false;
        seenUsers.add(row.userName);
        return true;
    });
};

const applyUserScope = <T extends CandidateMessage>(rows: T[], userScope: UserScope): T[] => {
    const named = rows.filter((row) => matchesUserScope(row, userScope));
    // A people *count* depends on the order messages appear in, so unlike a name
    // list it cannot be pushed into the query
    return userScope.type === 'anyone' && userScope.limit !== Infinity
        ? withinPeopleLimit(named, userScope.limit)
        : named;
};

/**
 * `candidates` must be the rows after the target, ascending by message id, with
 * a named user scope already applied in SQL.
 */
export const selectAttachedMessageIds = (
    candidates: CandidateMessage[],
    selection: SequentialSelection,
    userScope: UserScope,
    commandMessageId: number
): number[] => {
    const contentful = candidates.filter((row) => carriesOwnContent(row, commandMessageId));
    const scoped = applyUserScope(contentful, userScope);

    // The requested count includes the reply target ("`/chat 5` 将被回复的消息及
    // 后面的 4 条消息"), and the target reaches the context through the command's
    // own replyToId, so only count - 1 rows may be attached here. `/chat 1` is
    // therefore a pure summon that attaches nothing.
    const budget = match(selection)
        .with({ type: 'count' }, (counted) => counted.count - 1)
        .with({ type: 'all' }, () => undefined)
        .exhaustive();

    // Count last: "筛选后不会影响要添加的消息条数"
    return scoped.slice(0, budget).map((row) => row.messageId);
};

/**
 * The stretch of `rowsNewestFirst` with no gap longer than RECENT_GAP_MS, still
 * newest first. The gap is measured on every message in the chat — a burst of
 * conversation is made by everyone in it, whoever the user scope keeps later.
 */
const takeRecentBurst = (
    rowsNewestFirst: RecentCandidate[],
    anchorDate: Date | null
): RecentCandidate[] => {
    const burst: RecentCandidate[] = [];
    let previousTime = anchorDate?.getTime() ?? null;
    for (const row of rowsNewestFirst) {
        const time = row.date.getTime();
        if (previousTime !== null && previousTime - time > RECENT_GAP_MS) break;
        burst.push(row);
        previousTime = time;
    }
    return burst;
};

/**
 * `/chat r`: `rowsNewestFirst` are the rows before the anchor (the reply target,
 * or the command itself when there is none), descending by message id and
 * unfiltered. Returns ascending message ids.
 */
export const selectRecentMessageIds = (
    rowsNewestFirst: RecentCandidate[],
    options: RecentSelectionOptions
): number[] => {
    const burst = takeRecentBurst(rowsNewestFirst, options.anchorDate);
    const contentful = burst.filter((row) => carriesOwnContent(row, options.commandMessageId));
    // Scope walks away from the anchor, so `-N` admits the N people nearest to it
    const scoped = applyUserScope(contentful, options.userScope);
    return scoped
        .slice(0, options.maxMessages)
        .map((row) => row.messageId)
        .reverse();
};
