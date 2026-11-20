/**
 * The runtime block's reaction view (design 2026-1120-1312 §4.3): the
 * `message_reactions` rows of one assembled context, reduced to grouped and
 * ordered lines keyed by the context's own `#N`.
 *
 * Grouping and ordering happen here, on the reply layer, so the `ai` layer keeps
 * its zero `db` dependency: `buildRuntimeContext` receives the finished view and
 * only formats it. Nothing here touches the database or the clock — the same
 * rows always render the same text, whatever order the rows were written in.
 *
 * Sorting rules (all deterministic):
 * - message lines by `#N` ascending;
 * - a message's entries: standard emoji first, then custom emoji by their id,
 *   then paid reactions last;
 * - an entry's actors: users by id, anonymous admins/channels by chat id, the
 *   bot itself last.
 */
import { match } from 'ts-pattern';
import type { RuntimeReactionEntry, RuntimeReactionGroup } from '../ai/system-prompt/runtime-context.js';
import type { StoredReaction } from '../db/queries/reaction-queries.js';
import { REACTION_EMOJIS } from '../shared/reaction-emoji.js';
import type { ContextNumbering } from './context-assembly.js';
import type { ReactionParticipant } from './context-users.js';

/** Names listed before the rest collapse into `…等 N 人` */
const MAX_ACTORS_PER_EMOJI = 4;

const CUSTOM_EMOJI_LABEL = '[自定义表情]';
const PAID_REACTION_LABEL = '⭐';
const MODEL_ACTOR_NAME = '模型';
const ANONYMOUS_ACTOR_NAME = '匿名';

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

/** One message's reactions as entries, in render order */
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
        const entries = entriesOf(rows);
        if (entries.length > 0) groups.push({ number, entries });
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
