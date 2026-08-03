/**
 * Which of the messages after the reply target a `/chat` actually attaches.
 *
 * Pure, so the rules the help text promises can be asserted offline. Each rule
 * below fixes a way the old inline version broke that promise: it filtered by
 * the *sender's* name for `-s`, let one person too many through `-N`, truncated
 * to the requested count before filtering rather than after, and spent slots on
 * rows that carry no content of their own (the command message itself and
 * media-group sub-images).
 */
import type { ChatCommandSpec } from './chat-command-parser.js';

/** One candidate row, projected without the media blob */
export interface CandidateMessage {
    messageId: number;
    userName: string;
    text: string | null;
}

/** Media-group members whose media rides on the group's first message */
const SUB_IMAGE_PATTERN = /sub image of \[\w+\]/;

const carriesOwnContent = (row: CandidateMessage, commandMessageId: number): boolean =>
    row.messageId !== commandMessageId && !(row.text && SUB_IMAGE_PATTERN.test(row.text));

/** Keep messages until `limit` distinct people have been seen */
const withinPeopleLimit = (rows: CandidateMessage[], limit: number): CandidateMessage[] => {
    const seenUsers = new Set<string>();
    return rows.filter((row) => {
        if (seenUsers.has(row.userName)) return true;
        if (seenUsers.size >= limit) return false;
        seenUsers.add(row.userName);
        return true;
    });
};

/**
 * `candidates` must be the rows after the target, ascending by message id, with
 * a named user scope already applied in SQL.
 */
export const selectAttachedMessageIds = (
    candidates: CandidateMessage[],
    spec: ChatCommandSpec,
    commandMessageId: number
): number[] => {
    const contentful = candidates.filter((row) => carriesOwnContent(row, commandMessageId));

    // A people *count* depends on the order messages appear in, so unlike a name
    // list it cannot be pushed into the query
    const scoped =
        spec.userScope.type === 'anyone' && spec.userScope.limit !== Infinity
            ? withinPeopleLimit(contentful, spec.userScope.limit)
            : contentful;

    // Count last: "筛选后不会影响要添加的消息条数"
    return scoped
        .slice(0, spec.messageCount === Infinity ? undefined : spec.messageCount)
        .map((row) => row.messageId);
};
