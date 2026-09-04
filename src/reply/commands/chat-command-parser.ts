/**
 * `/chat` syntax, parsed in exactly one place.
 *
 * Three call sites used to carry their own copy of one big regex — autoSave (to
 * strip the command off the stored text), the command handler (to read the
 * parameters) and the reply gate (to decide whether to answer) — and they
 * disagreed: only the gate accepted the `/chat@BotName` form Telegram inserts in
 * groups, and none of them looked at a photo's caption.
 */
import { match, P } from 'ts-pattern';
import { parseTelegramMessageLink, type TelegramMessageLink } from './telegram-message-link.js';

/** How many people's messages to pull in */
export type UserScope =
    /** Everyone, up to `limit` distinct people (Infinity = no limit) */
    | { type: 'anyone'; limit: number }
    /** Only these names (the reply target's author is always included) */
    | { type: 'named'; names: string[] };

/** Which messages the command pulls into the context */
export type MessageSelection =
    /** `/chat 5`: the reply target plus the next count-1 messages */
    | { type: 'count'; count: number }
    /** `/chat a`: every message after the reply target */
    | { type: 'all' }
    /** `/chat r`: the recent burst of conversation, walking back from the target (or from now) */
    | { type: 'recent' }
    /** `/chat https://t.me/…`: splice the conversation(s) around the linked message(s) into this one */
    | { type: 'link'; links: TelegramMessageLink[] };

/** The selections that walk forward from the reply target, message by message */
export type SequentialSelection = Extract<MessageSelection, { type: 'count' | 'all' }>;

export interface ChatCommandSpec {
    selection: MessageSelection;
    userScope: UserScope;
    /** What the user wrote for the model after the parameters; null if nothing */
    prompt: string | null;
}

export type ChatCommandParse =
    /** Not a `/chat` command at all */
    | { type: 'none' }
    /** A `/chat` whose parameters are missing or malformed → show the help */
    | { type: 'invalid' }
    | { type: 'valid'; spec: ChatCommandSpec };

/**
 * `/chat`, optionally addressed as `/chat@BotName`, then the parameters. Kept
 * deliberately loose: any first token is captured here and validated below, so
 * `/chat 5a` shows the help instead of silently becoming `NaN`.
 */
const COMMAND_PATTERN =
    /^\/chat(?:@(\S+))?(?=\s|$)(?:\s+(\S+))?(?:\s+(-\S+))?\s*([\s\S]*)$/;

const NO_USER_SCOPE: UserScope = { type: 'anyone', limit: Infinity };

/**
 * A command explicitly addressed to another bot is not ours to answer — with
 * privacy mode off we receive those too, and we used to treat any `@whatever`
 * as our own.
 */
const isAddressedToUs = (mention: string | undefined): boolean => {
    if (!mention) return true;
    const ownUserName = process.env.BOT_USER_NAME;
    if (!ownUserName) return true; // unconfigured: keep answering as before
    return mention.toLowerCase() === ownUserName.toLowerCase();
};

/** Bare `/chat` prefix test, for callers that only need "is this the command?" */
export const isChatCommandText = (rawText: string | undefined): boolean =>
    parseChatCommand(rawText).type !== 'none';

/** `a` / `all` → everything after the target; `r` / `recent` → the recent burst; else a positive integer */
const parseSelectionToken = (token: string | undefined): MessageSelection | null =>
    match(token?.toLowerCase())
        .with('a', 'all', () => ({ type: 'all' as const }))
        .with('r', 'recent', () => ({ type: 'recent' as const }))
        .with(P.string.regex(/^[1-9]\d*$/), (digits) => ({
            type: 'count' as const,
            count: Number(digits),
        }))
        .otherwise(() => null);

/**
 * The optional second parameter, e.g. `-s`, `-3`, `-李四/王五`.
 * `targetAuthor` is the author of the replied-to message: `-s` means "only that
 * person", and a name list always implies them too.
 */
const parseUserScope = (token: string | undefined, targetAuthor: string): UserScope =>
    match(token?.slice(1))
        .with(undefined, () => NO_USER_SCOPE)
        .with('', () => NO_USER_SCOPE)
        .with('s', () => ({ type: 'named' as const, names: [targetAuthor] }))
        .with(P.string.regex(/^[1-9]\d*$/), (digits) => ({
            type: 'anyone' as const,
            limit: Number(digits),
        }))
        .otherwise((names) => ({
            type: 'named' as const,
            names: [...new Set([...names.split('/').filter(Boolean), targetAuthor])],
        }));

/**
 * Link mode: the first token was a message link; any further leading tokens of
 * `trailing` that are links join it, and whatever follows is the prompt.
 */
const parseLinkSelection = (
    firstLink: TelegramMessageLink,
    trailing: string
): { selection: MessageSelection; prompt: string | null } => {
    const links = [firstLink];
    let rest = trailing.trimStart();
    for (;;) {
        const nextToken = rest.match(/^\S+/)?.[0];
        if (nextToken === undefined) break;
        const nextLink = parseTelegramMessageLink(nextToken);
        if (nextLink === null) break;
        links.push(nextLink);
        rest = rest.slice(nextToken.length).trimStart();
    }
    return { selection: { type: 'link', links }, prompt: rest.trim() || null };
};

/**
 * Parse a `/chat` command out of a message's text or caption.
 *
 * `targetAuthor` is the first name of the replied-to message's author; pass an
 * empty string when unknown (the handler rejects a missing target before the
 * scope matters).
 */
export const parseChatCommand = (
    rawText: string | undefined,
    targetAuthor = ''
): ChatCommandParse => {
    const matched = rawText?.match(COMMAND_PATTERN);
    if (!matched) return { type: 'none' };

    const [, mention, firstToken, scopeToken, trailing = ''] = matched;
    if (!isAddressedToUs(mention)) return { type: 'none' };

    const firstLink = firstToken === undefined ? null : parseTelegramMessageLink(firstToken);
    if (firstLink !== null) {
        // A user filter makes no sense for splicing whole conversations
        if (scopeToken !== undefined) return { type: 'invalid' };
        const { selection, prompt } = parseLinkSelection(firstLink, trailing);
        return { type: 'valid', spec: { selection, userScope: NO_USER_SCOPE, prompt } };
    }

    const selection = parseSelectionToken(firstToken);
    if (selection === null) return { type: 'invalid' };

    return {
        type: 'valid',
        spec: {
            selection,
            userScope: parseUserScope(scopeToken, targetAuthor),
            prompt: trailing.trim() || null,
        },
    };
};

/**
 * The spec as stored on the message row (`telegram_messages.chatCommand`), which
 * is what marks the message as a `/chat` summon at context-build time. The
 * prompt is left out — it is the message's own text.
 */
export const serializeChatCommand = (spec: ChatCommandSpec): string =>
    match(spec.selection)
        .with({ type: 'link' }, (selection) =>
            JSON.stringify({
                mode: 'link',
                linkedMessageIds: selection.links.map((link) => link.messageId),
            })
        )
        .with({ type: P.union('count', 'all', 'recent') }, (selection) =>
            JSON.stringify({
                // JSON has no Infinity: `a` and `r` are stored as their letters
                messageCount: match(selection)
                    .with({ type: 'count' }, (counted) => counted.count)
                    .with({ type: 'all' }, () => 'a')
                    .with({ type: 'recent' }, () => 'r')
                    .exhaustive(),
                userScope:
                    spec.userScope.type === 'named'
                        ? spec.userScope
                        : {
                            type: 'anyone',
                            limit: spec.userScope.limit === Infinity ? 'a' : spec.userScope.limit,
                        },
            })
        )
        .exhaustive();

/** What the context builder needs to know about a stored `/chat` row */
export type StoredChatCommand =
    /** Pulled messages in and summoned a reply (count / all / recent, and every row stored before link mode existed) */
    | { mode: 'summon' }
    /** Spliced other conversations in; no reply was asked for */
    | { mode: 'link'; linkedMessageIds: number[] };

export const readStoredChatCommand = (stored: string): StoredChatCommand => {
    try {
        const parsed: unknown = JSON.parse(stored);
        return match(parsed)
            .with({ mode: 'link', linkedMessageIds: P.array(P.number) }, (link) => ({
                mode: 'link' as const,
                linkedMessageIds: link.linkedMessageIds,
            }))
            .otherwise(() => ({ mode: 'summon' as const }));
    } catch {
        return { mode: 'summon' };
    }
};
