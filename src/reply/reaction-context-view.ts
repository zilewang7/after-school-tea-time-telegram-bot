/**
 * The runtime block's reaction view (design 2026-1123-1610 §4): the
 * `message_reactions` rows of one assembled context, reduced to grouped and
 * ordered lines keyed by the context's own `#N`.
 *
 * A reply reaches the chat as several messages (the body may be split, the CoT
 * and the folded search/Tools footers are link messages of their own, the media
 * are their own messages). Each reaction row snapshots the part it landed on, so
 * the view first groups one `#N`'s rows by part and then reduces each part's rows
 * to its entries. The result is one reaction line per part:
 *
 * - a product part (link message, picture, GIF, sticker, file, card) is labelled
 *   whenever it was reacted to, even when it is the only part that was;
 * - the body is unlabelled when the reply has exactly one reacted part (people
 *   reacted to the reply's text as a whole); with two or more reacted parts each
 *   body segment is labelled, so the model can tell them apart;
 * - rows written before the parts model (part NULL) read as 整条 in a multi-part
 *   reply and unlabelled otherwise; they disappear as those rows age out.
 *
 * Grouping, ordering and labelling happen here, on the reply layer, so the `ai`
 * layer keeps its zero `db` dependency: `buildRuntimeContext` receives the
 * finished view and only formats it. Nothing here touches the database or the
 * clock — the same rows always render the same text, whatever order the rows
 * were written in.
 *
 * Sorting rules (all deterministic):
 * - message groups by `#N` ascending;
 * - a message's parts: body segments by index, then `REPLY_PART_ORDER` (CoT
 *   link, search link, Tools link, pictures by index, GIF, sticker, file, card,
 *   card link), legacy unknown rows last;
 * - a part's entries: standard emoji first, then custom emoji by their id, then
 *   paid reactions last;
 * - an entry's actors: users by id, anonymous admins/channels by chat id, the
 *   bot itself last.
 */
import { match } from 'ts-pattern';
import type {
    RuntimeReactionEntry,
    RuntimeReactionGroup,
    RuntimeReactionPart,
} from '../ai/system-prompt/runtime-context.js';
import type { StoredReaction } from '../db/queries/reaction-queries.js';
import { REACTION_EMOJIS } from '../shared/reaction-emoji.js';
import {
    isBodyPart,
    replyPartLabelOf,
    replyPartRankOf,
    type ReplyPartKind,
} from '../shared/reply-part.js';
import type { ContextNumbering } from './context-assembly.js';
import type { ReactionParticipant } from './context-users.js';

/** Names listed before the rest collapse into `…等 N 人` */
const MAX_ACTORS_PER_EMOJI = 4;

const CUSTOM_EMOJI_LABEL = '[自定义表情]';
const PAID_REACTION_LABEL = '⭐';
const MODEL_ACTOR_NAME = '模型';
const ANONYMOUS_ACTOR_NAME = '匿名';
/** Rows written before the parts model: one reply-level line, not a position */
const LEGACY_PART_LABEL = '整条';

/** The shared list's index: standard reactions render in Telegram's own order */
const EMOJI_ORDER = new Map<string, number>(REACTION_EMOJIS.map((emoji, index) => [emoji, index]));

/** The sort key of one standard emoji; an unknown one sorts after every known one */
const emojiSortKeyOf = (emoji: string): string => {
    const order = EMOJI_ORDER.get(emoji);
    return order === undefined ? `9999${emoji}` : String(order).padStart(4, '0');
};

/**
 * One reaction entry under construction: what it reads as and how it sorts.
 * Standard emoji follow `REACTION_EMOJIS` (Telegram's own order), custom emoji
 * sort by their id, paid reactions come last.
 */
interface EntryShape {
    readonly key: string;
    readonly rank: number;
    readonly sortKey: string;
    readonly label: string;
}

const entryShapeOf = (row: StoredReaction): EntryShape | null =>
    match(row.kind)
        .with('emoji', () =>
            row.emoji === null
                ? null
                : {
                      key: `emoji:${row.emoji}`,
                      rank: 0,
                      sortKey: emojiSortKeyOf(row.emoji),
                      label: row.emoji,
                  }
        )
        .with('custom_emoji', () =>
            row.customEmojiId === null
                ? null
                : {
                      key: `custom:${row.customEmojiId}`,
                      rank: 1,
                      sortKey: row.customEmojiId,
                      label: CUSTOM_EMOJI_LABEL,
                  }
        )
        .with('paid', () => ({ key: 'paid', rank: 2, sortKey: '', label: PAID_REACTION_LABEL }))
        .exhaustive();

/** Code-point comparison: stable across locales and machines */
const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** Which actor a row belongs to; the same person's several reactions collapse */
const actorKeyOf = (row: StoredReaction): string => {
    if (row.fromBotSelf) return 'bot';
    if (row.userId === null) return `chat:${row.actorChatId ?? 'none'}`;
    return `user:${row.userId}`;
};

/** Users first (by id), anonymous actors next (by chat id), the model last */
const compareActors = (left: StoredReaction, right: StoredReaction): number => {
    if (left.fromBotSelf !== right.fromBotSelf) return left.fromBotSelf ? 1 : -1;
    if (left.fromBotSelf) return 0;
    if (left.userId === null && right.userId !== null) return 1;
    if (left.userId !== null && right.userId === null) return -1;
    if (left.userId !== null && right.userId !== null) return left.userId - right.userId;
    return (left.actorChatId ?? 0) - (right.actorChatId ?? 0);
};

const actorNameOf = (row: StoredReaction): string => {
    if (row.fromBotSelf) return MODEL_ACTOR_NAME;
    if (row.userId === null) return ANONYMOUS_ACTOR_NAME;
    const name = row.userName?.trim() ?? '';
    return name === '' ? `用户 ${row.userId}` : name;
};

/** One part's reactions as entries, in render order */
const entriesOf = (rows: readonly StoredReaction[]): RuntimeReactionEntry[] => {
    const entries = new Map<string, EntryShape & { actors: Map<string, StoredReaction> }>();

    for (const row of rows) {
        const shape = entryShapeOf(row);
        if (shape === null) continue;
        let entry = entries.get(shape.key);
        if (entry === undefined) {
            entry = { ...shape, actors: new Map() };
            entries.set(shape.key, entry);
        }
        const actorKey = actorKeyOf(row);
        if (!entry.actors.has(actorKey)) entry.actors.set(actorKey, row);
    }

    return [...entries.values()]
        .sort((left, right) => left.rank - right.rank || compareText(left.sortKey, right.sortKey))
        .map((entry) => {
            const actors = [...entry.actors.values()].sort(compareActors);
            const shown = actors.slice(0, MAX_ACTORS_PER_EMOJI);
            return {
                emoji: entry.label,
                actors: shown.map(actorNameOf),
                moreActors: actors.length - shown.length,
            };
        });
};

/** One part of a reply under construction: its rows and where it sorts */
interface PartRows {
    /** The rows a reaction landed on for this part; `part` is null for legacy rows */
    readonly part: ReplyPartKind | null;
    readonly partIndex: number | null;
    readonly rows: StoredReaction[];
}

/**
 * Split one reply's rows by the part they landed on. The same kind and index is
 * one part even when the layout re-delivered it under a new message id (a
 * version switch): the model sees one reply, so it gets one line.
 */
const partsOf = (rows: readonly StoredReaction[]): PartRows[] => {
    const parts = new Map<string, PartRows>();
    for (const row of rows) {
        const key = row.part === null ? 'legacy' : `${row.part}#${row.partIndex ?? ''}`;
        const part = parts.get(key);
        if (part === undefined) {
            parts.set(key, { part: row.part, partIndex: row.partIndex, rows: [row] });
        } else {
            part.rows.push(row);
        }
    }
    return [...parts.values()];
};

/** One non-empty part ready to be labelled and rendered */
interface PartView {
    readonly part: ReplyPartKind | null;
    readonly partIndex: number | null;
    readonly entries: RuntimeReactionEntry[];
}

/**
 * Where a part sorts: body segments by index first, then the fixed kind order,
 * then legacy rows (which cannot name a part) last.
 */
const compareParts = (left: PartView, right: PartView): number => {
    if (left.part === null || right.part === null) {
        if (left.part !== null) return -1;
        return right.part !== null ? 1 : 0;
    }
    const byRank = replyPartRankOf(left.part) - replyPartRankOf(right.part);
    if (byRank !== 0) return byRank;
    return (left.partIndex ?? 1) - (right.partIndex ?? 1);
};

/**
 * The label of one part, decided by the reply as a whole: a product part always
 * names itself; the body only names its segment when the reply has more than one
 * reacted part (a single reacted body part is "the reply's body", whatever
 * segment it was); a legacy row reads as 整条 only in the multi-part case.
 */
const labelOf = (part: ReplyPartKind | null, partIndex: number | null, partCount: number): string | null => {
    if (part === null) return partCount > 1 ? LEGACY_PART_LABEL : null;
    if (isBodyPart(part) && partCount === 1) return null;
    return replyPartLabelOf(part, partIndex);
};

/**
 * Reduce the reaction rows of one context to the runtime block's view. Rows of
 * messages the context does not number are dropped: only what the model can
 * point at is worth showing.
 */
export const buildRuntimeReactionView = (
    reactions: readonly StoredReaction[],
    numbering: ContextNumbering
): RuntimeReactionGroup[] => {
    const rowsByMessageId = new Map<number, StoredReaction[]>();
    for (const reaction of reactions) {
        if (!numbering.numberOf.has(reaction.messageId)) continue;
        const rows = rowsByMessageId.get(reaction.messageId);
        if (rows === undefined) {
            rowsByMessageId.set(reaction.messageId, [reaction]);
        } else {
            rows.push(reaction);
        }
    }

    const groups: RuntimeReactionGroup[] = [];
    for (const [messageId, rows] of rowsByMessageId) {
        const number = numbering.numberOf.get(messageId);
        if (number === undefined) continue;
        // Parts with no renderable entry (an unknown reaction kind) do not count
        // as reacted parts when the body's labelling is decided.
        const partViews: PartView[] = partsOf(rows).flatMap((part) => {
            const entries = entriesOf(part.rows);
            return entries.length === 0 ? [] : [{ part: part.part, partIndex: part.partIndex, entries }];
        });
        if (partViews.length === 0) continue;
        partViews.sort(compareParts);
        const parts: RuntimeReactionPart[] = partViews.map((part) => ({
            label: labelOf(part.part, part.partIndex, partViews.length),
            entries: part.entries,
        }));
        groups.push({ number, parts });
    }

    return groups.sort((left, right) => left.number - right.number);
};

/**
 * The people behind the reaction rows that belong in the roster. Anonymous
 * admins/channels (no user id) and the bot itself are not people to mention,
 * so they are left out; the roster layer still skips an automated account.
 */
export const reactionParticipantsOf = (
    reactions: readonly StoredReaction[]
): ReactionParticipant[] => {
    const nameById = new Map<number, string>();
    for (const row of reactions) {
        if (row.fromBotSelf || row.userId === null) continue;
        const name = row.userName?.trim() ?? '';
        const previous = nameById.get(row.userId);
        if (previous === undefined || (previous === '' && name !== '')) {
            nameById.set(row.userId, name);
        }
    }
    return [...nameById].map(([userId, name]) => ({
        userId,
        name: name === '' ? `用户 ${userId}` : name,
    }));
};
