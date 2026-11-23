/**
 * The reaction pills of one share page (design 2026-1123 share addendum): what
 * a public page shows under a message, Telegram-style — the emoji and how many
 * people used it.
 *
 * Public pages never show reactor names: a share link is open to anyone holding
 * it, and the people who reacted are not its authors. Counts only, one pill per
 * emoji; a custom emoji reaction collapses into `[自定义表情]` (the public page
 * cannot render the sticker) and a paid one reads `⭐`. The bot's own reaction
 * counts as one actor, like everyone else's.
 *
 * The data is the same `message_reactions` state the runtime block reads; this
 * module only reduces it, so a change of that storage shows here automatically.
 */
import type { StoredReaction } from '../../db/queries/reaction-queries.js';
import { REACTION_EMOJIS } from '../../shared/reaction-emoji.js';

/** One reaction pill: what the page shows and how many actors are behind it */
export interface ShareReactionPill {
    readonly emoji: string;
    readonly count: number;
}

const CUSTOM_EMOJI_LABEL = '[自定义表情]';
const PAID_REACTION_LABEL = '⭐';

/** Telegram's own order for standard reactions; unknown emoji keep a stable tail */
const EMOJI_ORDER = new Map<string, number>(REACTION_EMOJIS.map((emoji, index) => [emoji, index]));

/** The pill label of one row; null when the row cannot be shown (no emoji at all) */
const labelOf = (row: StoredReaction): string | null => {
    if (row.kind === 'custom_emoji') return CUSTOM_EMOJI_LABEL;
    if (row.kind === 'paid') return PAID_REACTION_LABEL;
    return row.emoji === null || row.emoji === '' ? null : row.emoji;
};

/** Deterministic pill order: Telegram's emoji order, then custom, then paid */
const sortKeyOf = (label: string): string => {
    const order = EMOJI_ORDER.get(label);
    if (order !== undefined) return `0${String(order).padStart(4, '0')}`;
    if (label === CUSTOM_EMOJI_LABEL) return '1';
    if (label === PAID_REACTION_LABEL) return '2';
    // An emoji outside the known set still sorts before the two labels
    return `0${label}`;
};

/** Which person a row belongs to; the same actor on several parts counts once */
const actorKeyOf = (row: StoredReaction): string => {
    if (row.fromBotSelf) return 'bot';
    if (row.userId !== null) return `user:${row.userId}`;
    return `chat:${row.actorChatId ?? 'none'}`;
};

/**
 * Reduce one message's reaction rows to pills. Rows of the same label merge;
 * the count is distinct actors, so one person changing their reaction never
 * counts twice (the storage already replaces that actor's rows, but a legacy
 * row and a new one may briefly coexist).
 */
export const reactionPillsOf = (rows: readonly StoredReaction[]): ShareReactionPill[] => {
    const groups = new Map<string, { actors: Set<string> }>();
    for (const row of rows) {
        const label = labelOf(row);
        if (label === null) continue;
        const group = groups.get(label) ?? { actors: new Set<string>() };
        group.actors.add(actorKeyOf(row));
        groups.set(label, group);
    }
    return [...groups.entries()]
        .sort(([left], [right]) => {
            const leftKey = sortKeyOf(left);
            const rightKey = sortKeyOf(right);
            return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
        })
        .map(([emoji, group]) => ({ emoji, count: group.actors.size }));
};

/** The pills of every message a share page displays, keyed by message id */
export const groupReactionPillsByMessage = (
    rows: readonly StoredReaction[]
): Map<number, ShareReactionPill[]> => {
    const rowsByMessageId = new Map<number, StoredReaction[]>();
    for (const row of rows) {
        const list = rowsByMessageId.get(row.messageId);
        if (list === undefined) rowsByMessageId.set(row.messageId, [row]);
        else list.push(row);
    }
    const pillsByMessageId = new Map<number, ShareReactionPill[]>();
    for (const [messageId, list] of rowsByMessageId) {
        const pills = reactionPillsOf(list);
        if (pills.length > 0) pillsByMessageId.set(messageId, pills);
    }
    return pillsByMessageId;
};
