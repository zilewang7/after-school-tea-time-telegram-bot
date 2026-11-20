/**
 * The standard Telegram reaction emoji, for the code paths that need the set at
 * run time: the react_to_message schema enum and the /react emoji regex.
 *
 * @grammyjs/types is a type-only package (no runtime exports), so the list
 * cannot be derived from the type and is written out here. `satisfies` makes
 * the compiler reject a character grammy does not accept, so an upgrade that
 * changes the set fails the build instead of silently diverging.
 */
import type { ReactionTypeEmoji } from 'grammy/types';

export const REACTION_EMOJIS = [
    '👍', '👎', '❤', '🔥',
    '🥰', '👏', '😁', '🤔',
    '🤯', '😱', '🤬', '😢',
    '🎉', '🤩', '🤮', '💩',
    '🙏', '👌', '🕊', '🤡',
    '🥱', '🥴', '😍', '🐳',
    '❤‍🔥', '🌚', '🌭', '💯',
    '🤣', '⚡', '🍌', '🏆',
    '💔', '🤨', '😐', '🍓',
    '🍾', '💋', '🖕', '😈',
    '😴', '😭', '🤓', '👻',
    '👨‍💻', '👀', '🎃', '🙈',
    '😇', '😨', '🤝', '✍',
    '🤗', '🫡', '🎅', '🎄',
    '☃', '💅', '🤪', '🗿',
    '🆒', '💘', '🙉', '🦄',
    '😘', '💊', '🙊', '😎',
    '👾', '🤷‍♂', '🤷', '🤷‍♀',
    '😡',
] as const satisfies readonly ReactionTypeEmoji['emoji'][];

/** One standard reaction emoji */
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

export const REACTION_EMOJI_SET: ReadonlySet<string> = new Set(REACTION_EMOJIS);

/** Narrow a string to the standard set: model input is validated with it */
export const isReactionEmoji = (value: string): value is ReactionEmoji => REACTION_EMOJI_SET.has(value);
