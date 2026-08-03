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

/** How many people's messages to pull in */
export type UserScope =
    /** Everyone, up to `limit` distinct people (Infinity = no limit) */
    | { type: 'anyone'; limit: number }
    /** Only these names (the reply target's author is always included) */
    | { type: 'named'; names: string[] };

export interface ChatCommandSpec {
    /** Upper bound on how many messages to pull in; Infinity for `a` */
    messageCount: number;
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
 * `/chat` or `/chat@BotName`, then the parameters. Kept deliberately loose: any
 * first token is captured here and validated below, so `/chat 5a` shows the help
 * instead of silently becoming `NaN`.
 */
const COMMAND_PATTERN =
    /^\/chat(?:@\S+)?(?=\s|$)(?:\s+(\S+))?(?:\s+(-\S+))?\s*([\s\S]*)$/;

/** Bare `/chat` prefix test, for callers that only need "is this the command?" */
export const isChatCommandText = (rawText: string | undefined): boolean =>
    Boolean(rawText && COMMAND_PATTERN.test(rawText));

/** `a` → every message after the target; otherwise a positive integer */
const parseMessageCount = (token: string | undefined): number | null =>
    match(token)
        .with('a', () => Infinity)
        .with(P.string.regex(/^[1-9]\d*$/), (digits) => Number(digits))
        .otherwise(() => null);

/**
 * The optional second parameter, e.g. `-s`, `-3`, `-李四/王五`.
 * `targetAuthor` is the author of the replied-to message: `-s` means "only that
 * person", and a name list always implies them too.
 */
const parseUserScope = (token: string | undefined, targetAuthor: string): UserScope =>
    match(token?.slice(1))
        .with(undefined, () => ({ type: 'anyone' as const, limit: Infinity }))
        .with('', () => ({ type: 'anyone' as const, limit: Infinity }))
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
 * Parse a `/chat` command out of a message's text or caption.
 *
 * `targetAuthor` is the first name of the replied-to message's author; pass an
 * empty string when unknown (the command needs a reply target anyway, and the
 * handler rejects it before the scope matters).
 */
export const parseChatCommand = (
    rawText: string | undefined,
    targetAuthor = ''
): ChatCommandParse => {
    const matched = rawText?.match(COMMAND_PATTERN);
    if (!matched) return { type: 'none' };

    const [, countToken, scopeToken, trailing = ''] = matched;

    const messageCount = parseMessageCount(countToken);
    if (messageCount === null) return { type: 'invalid' };

    const prompt = trailing.trim() || null;

    return {
        type: 'valid',
        spec: { messageCount, userScope: parseUserScope(scopeToken, targetAuthor), prompt },
    };
};

/**
 * The spec as stored on the message row (`telegram_messages.chatCommand`), which
 * is what marks the message as a `/chat` summon at context-build time. The
 * prompt is left out — it is the message's own text.
 */
export const serializeChatCommand = (spec: ChatCommandSpec): string =>
    JSON.stringify({
        messageCount: spec.messageCount === Infinity ? 'a' : spec.messageCount,
        // JSON has no Infinity, so an unbounded people count reads as 'a' too
        userScope:
            spec.userScope.type === 'named'
                ? spec.userScope
                : {
                    type: 'anyone',
                    limit: spec.userScope.limit === Infinity ? 'a' : spec.userScope.limit,
                },
    });
