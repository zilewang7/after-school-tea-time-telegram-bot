/**
 * Which messages one reply's context holds, and the `#N` each of them gets:
 * the reply tree around the trigger, the trigger itself, and the replied-to
 * messages the tree misses. Free of side effects (nothing is published to the
 * process state, nothing is written), so buildContext and the panel's tree
 * view share it and number the same messages the same way.
 */
import {
    getContextMessage,
    getRepliesHistory,
    loadContextExclusions,
    type ContextMessage,
} from '../db/queries/context-queries.js';

/**
 * How many replied-to messages may be pulled into the context when they are not
 * part of the assembled tree. Bounded because each one drags its media along.
 */
const MAX_PULLED_REPLY_TARGETS = 8;

/**
 * Media-group members other than the first carry no content of their own — their
 * media is attached to the group's first message, which is the one in context.
 */
const SUB_IMAGE_PATTERN = /sub image of \[\w+\]/;

export const isSubImage = (msg: ContextMessage): boolean =>
    Boolean(msg.text && SUB_IMAGE_PATTERN.test(msg.text));

/**
 * Numbering of one assembled context: a `#N` label for every message plus a
 * lookup of everything in the context, so a reply can point at a number instead
 * of a truncated excerpt.
 */
export interface ContextNumbering {
    /** messageId → display number; every message in the context has one */
    numberOf: Map<number, number>;
    /** Every message in the assembled context, by message id */
    byId: Map<number, ContextMessage>;
}

/**
 * Number every message in context order, the bot's own replies included, so it
 * can point at what it said itself (`我在 #5 说过`) instead of describing it.
 */
export const buildContextNumbering = (messages: ContextMessage[]): ContextNumbering => {
    const numberOf = new Map<number, number>();
    const byId = new Map<number, ContextMessage>();

    for (const message of messages) {
        byId.set(message.messageId, message);
        numberOf.set(message.messageId, numberOf.size + 1);
    }

    return { numberOf, byId };
};

/** The distinct reply targets of `messages` that none of `present` holds, oldest reference first */
const missingReplyTargetIds = (
    messages: readonly ContextMessage[],
    present: ReadonlySet<number>,
    skip: ReadonlySet<number>
): number[] => [
    ...new Set(
        messages
            .map((message) => message.replyToId)
            .filter((id): id is number => id !== null && !present.has(id) && !skip.has(id))
    ),
];

/**
 * Messages that are replied to but missing from the assembled tree (e.g. a
 * /chat-added message answering something outside the reply chain), so the
 * reply can be referenced by number rather than by excerpt. One level only,
 * capped. A continuation id resolves to its reply's first message, which is
 * skipped when it is excluded or already in the context.
 */
const pullMissingReplyTargets = async (
    chatId: number,
    messages: readonly ContextMessage[],
    skip: ReadonlySet<number>
): Promise<ContextMessage[]> => {
    const present = new Set(messages.map((message) => message.messageId));
    const missingIds = missingReplyTargetIds(messages, present, skip);
    if (!missingIds.length) return [];

    if (missingIds.length > MAX_PULLED_REPLY_TARGETS) {
        console.log(
            `[context-builder] ${missingIds.length - MAX_PULLED_REPLY_TARGETS} replied-to message(s) left out of context (cap ${MAX_PULLED_REPLY_TARGETS})`
        );
    }

    const pulled: ContextMessage[] = [];
    for (const messageId of missingIds.slice(0, MAX_PULLED_REPLY_TARGETS)) {
        const target = await getContextMessage(chatId, messageId);
        // Sub-images stay out: their media already rides on the group's first message
        if (!target || isSubImage(target)) continue;
        if (skip.has(target.messageId) || present.has(target.messageId)) continue;
        present.add(target.messageId);
        pulled.push(target);
    }
    return pulled;
};

/**
 * Tree view only: the excluded messages the context's messages reply to from
 * outside the tree, flagged, so they stay visible (and restorable) instead of
 * vanishing from the tree once excluded. They never take part in numbering.
 */
const pullExcludedReplyTargets = async (
    chatId: number,
    inContext: readonly ContextMessage[],
    present: ReadonlySet<number>,
    exclusions: ReadonlySet<number>,
    retried: ReadonlySet<number>
): Promise<ContextMessage[]> => {
    const candidateIds = missingReplyTargetIds(inContext, present, retried).slice(0, MAX_PULLED_REPLY_TARGETS);
    const seen = new Set(present);
    const flagged: ContextMessage[] = [];
    for (const messageId of candidateIds) {
        const target = await getContextMessage(chatId, messageId);
        if (!target || isSubImage(target)) continue;
        if (!exclusions.has(target.messageId) || seen.has(target.messageId)) continue;
        seen.add(target.messageId);
        flagged.push({ ...target, excludedFromContext: true });
    }
    return flagged;
};

export interface AssembleContextOptions {
    /** The trigger as the caller already holds it; read by id when absent */
    trigger?: ContextMessage;
    /** Messages left out on top of the exclusions (the reply being retried) */
    excludeMessageIds?: readonly number[];
    /** false: read-only, missing rows are never backfilled (panel). Default true */
    recover?: boolean;
    /**
     * Also return the excluded messages of the tree, flagged and unnumbered
     * (the panel's tree view). The trigger is flagged too when excluded: the
     * tree shows what the next reply would see.
     */
    includeExcluded?: boolean;
}

export interface AssembledContext {
    triggerId: number;
    /** The model's context in context order: buildContext renders exactly these */
    messages: ContextMessage[];
    /** With includeExcluded: the excluded messages around the context, flagged; otherwise empty */
    excludedMessages: ContextMessage[];
    /** `#N` of every message in `messages` */
    numbering: ContextNumbering;
    /** The chat's exclusions, as read for this assembly */
    exclusions: ReadonlySet<number>;
    /** Messages present only because a message of the context replies to them */
    replyTargetIds: ReadonlySet<number>;
}

/**
 * Assemble the context of a reply to `triggerId`: its reply tree (excluded
 * messages and `excludeMessageIds` left out), the trigger closing it, and the
 * replied-to messages the tree misses (never an excluded one).
 *
 * The order is the context order: the trigger stays last unless reply targets
 * were pulled in, which re-sorts everything by message id (so the trigger can
 * end up mid-context when the tree holds newer messages).
 */
export const assembleContextMessages = async (
    chatId: number,
    triggerId: number,
    opts: AssembleContextOptions = {}
): Promise<AssembledContext> => {
    const recover = opts.recover ?? true;
    const includeExcluded = opts.includeExcluded ?? false;
    const exclusions = await loadContextExclusions(chatId);
    const retried = new Set(opts.excludeMessageIds ?? []);

    const history = await getRepliesHistory(chatId, triggerId, {
        excludeSelf: true,
        recover,
        includeExcluded,
        exclusions,
    });
    const trigger = opts.trigger ?? (await getContextMessage(chatId, triggerId));
    if (!trigger) throw new Error(`[context-assembly] trigger ${triggerId} not found in chat ${chatId}`);
    // Excluding the trigger has no effect on its own reply; only the tree view flags it
    const closing: ContextMessage =
        includeExcluded && exclusions.has(trigger.messageId) ? { ...trigger, excludedFromContext: true } : trigger;

    const assembled = [...history.filter((message) => !retried.has(message.messageId)), closing];
    const inContext = assembled.filter((message) => message.excludedFromContext !== true);
    const skip = new Set<number>([...retried, ...exclusions]);
    const pulled = await pullMissingReplyTargets(chatId, inContext, skip);
    const messages = pulled.length
        ? [...inContext, ...pulled].sort((a, b) => a.messageId - b.messageId)
        : inContext;

    const flaggedInTree = assembled.filter((message) => message.excludedFromContext === true);
    const flaggedTargets = includeExcluded
        ? await pullExcludedReplyTargets(
              chatId,
              inContext,
              new Set([...assembled, ...pulled].map((message) => message.messageId)),
              exclusions,
              retried
          )
        : [];

    return {
        triggerId,
        messages,
        excludedMessages: [...flaggedInTree, ...flaggedTargets].sort((a, b) => a.messageId - b.messageId),
        numbering: buildContextNumbering(messages),
        exclusions,
        replyTargetIds: new Set([...pulled, ...flaggedTargets].map((message) => message.messageId)),
    };
};
