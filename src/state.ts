/**
 * Application state singleton module
 * Replaces global variables with a typed state object
 */

interface MediaGroupIdTemp {
    chatId: number;
    messageId: number;
    mediaGroupId: string;
}

interface AppStateType {
    // media group tracking
    mediaGroupIdTemp: MediaGroupIdTemp;
    // File tasks by "chatId:messageId". A message remains pending until every
    // original-media/custom-emoji task has settled.
    asynchronousFileSaveTasks: Map<string, Set<string>>;
    // Link-preview tasks by chat/message and revision-aware task id.
    asynchronousPreviewTasks: Map<string, Set<string>>;
    // OCR tasks use the same isolation; only blind models wait for them.
    asynchronousOcrTasks: Map<string, Set<string>>;
    // user messages edited while their response was still generating:
    // "chatId:userMessageId" (consumed at finalize to set EDIT_DETECTED)
    pendingEditsWhileProcessing: Set<string>;
    // continuation message registry: "chatId:continuationMsgId" -> firstMessageId
    continuationRegistry: Map<string, number>;
    // idempotency guard: "chatId:userMessageId" -> handled-at timestamp (ms)
    handledUserMessages: Map<string, number>;
    // context numbering of one assembled context, for turning the `#N` the model
    // writes into message links: "chatId:userMessageId" -> (#N -> messageId)
    contextNumbering: Map<string, Map<number, number>>;
    // user messages whose reply is still being generated:
    // "chatId:userMessageId" -> started-at (ms)
    repliesInFlight: Map<string, number>;
    // bot messages that are still being generated:
    // "chatId:botMessageId" -> started-at (ms)
    botRepliesInFlight: Map<string, number>;
    // replies a retry or continue is starting or running for:
    // "chatId:firstMessageId" -> claimed-at (ms)
    replyRerunClaims: Map<string, number>;
    // replies "继续" can pick up: "chatId:firstMessageId" -> version and expiry
    resumableMarks: Map<string, ResumableMark>;
}

/** Which version of a reply can be continued from its checkpoint, and until when */
export interface ResumableMark {
    /** The failed or stopped version a continue picks up */
    readonly versionId: number;
    /** Epoch ms; the mark no longer counts from this moment on */
    readonly expiresAt: number;
}

const createInitialState = (): AppStateType => ({
    mediaGroupIdTemp: {
        chatId: 0,
        messageId: 0,
        mediaGroupId: "",
    },
    asynchronousFileSaveTasks: new Map(),
    asynchronousPreviewTasks: new Map(),
    asynchronousOcrTasks: new Map(),
    pendingEditsWhileProcessing: new Set(),
    continuationRegistry: new Map(),
    handledUserMessages: new Map(),
    contextNumbering: new Map(),
    repliesInFlight: new Map(),
    botRepliesInFlight: new Map(),
    replyRerunClaims: new Map(),
    resumableMarks: new Map(),
});

// singleton instance
let appState: AppStateType | null = null;

export const getAppState = (): AppStateType => {
    if (!appState) {
        appState = createInitialState();
    }
    return appState;
};

// convenience accessors
export const getMediaGroupIdTemp = (): MediaGroupIdTemp => getAppState().mediaGroupIdTemp;
export const setMediaGroupIdTemp = (temp: MediaGroupIdTemp): void => {
    getAppState().mediaGroupIdTemp = temp;
};

const fileSaveKey = (chatId: number, messageId: number): string => `${chatId}:${messageId}`;

export const isAsyncFileSavePending = (chatId: number, messageId: number): boolean =>
    (getAppState().asynchronousFileSaveTasks.get(fileSaveKey(chatId, messageId))?.size ?? 0) > 0;

export const addAsyncFileSaveTask = (
    chatId: number,
    messageId: number,
    taskId: string
): void => {
    const key = fileSaveKey(chatId, messageId);
    const tasks = getAppState().asynchronousFileSaveTasks.get(key) ?? new Set<string>();
    tasks.add(taskId);
    getAppState().asynchronousFileSaveTasks.set(key, tasks);
};

export const removeAsyncFileSaveTask = (
    chatId: number,
    messageId: number,
    taskId: string
): void => {
    const key = fileSaveKey(chatId, messageId);
    const tasks = getAppState().asynchronousFileSaveTasks.get(key);
    if (!tasks) return;
    tasks.delete(taskId);
    if (tasks.size === 0) getAppState().asynchronousFileSaveTasks.delete(key);
};

export interface AsyncFileTaskRevision {
    updateId: number;
    telegramTimestamp: number;
}

const taskRevisionOf = (taskId: string): AsyncFileTaskRevision | null => {
    const parts = taskId.split(':');
    const updateId = Number(parts.at(-1));
    const telegramTimestamp = Number(parts.at(-2));
    return Number.isSafeInteger(updateId) && Number.isSafeInteger(telegramTimestamp)
        ? { updateId, telegramTimestamp }
        : null;
};

const isRevisionAfter = (
    candidate: AsyncFileTaskRevision,
    current: AsyncFileTaskRevision
): boolean =>
    candidate.telegramTimestamp > current.telegramTimestamp
    || (
        candidate.telegramTimestamp === current.telegramTimestamp
        && candidate.updateId > current.updateId
    );

export const retainAsyncFileSaveTasks = (
    chatId: number,
    messageId: number,
    currentRevision: AsyncFileTaskRevision,
    retainedTaskIds: readonly string[]
): void => {
    const key = fileSaveKey(chatId, messageId);
    const retained = new Set(retainedTaskIds);
    const tasks = getAppState().asynchronousFileSaveTasks.get(key);
    if (!tasks) return;
    for (const taskId of tasks) {
        const taskRevision = taskRevisionOf(taskId);
        const belongsToNewerUpdate = taskRevision !== null
            && isRevisionAfter(taskRevision, currentRevision);
        if (!retained.has(taskId) && !belongsToNewerUpdate) tasks.delete(taskId);
    }
    if (tasks.size === 0) getAppState().asynchronousFileSaveTasks.delete(key);
};

const addAsyncTask = (
    registry: Map<string, Set<string>>,
    chatId: number,
    messageId: number,
    taskId: string
): void => {
    const key = fileSaveKey(chatId, messageId);
    const tasks = registry.get(key) ?? new Set<string>();
    tasks.add(taskId);
    registry.set(key, tasks);
};

const removeAsyncTask = (
    registry: Map<string, Set<string>>,
    chatId: number,
    messageId: number,
    taskId: string
): void => {
    const key = fileSaveKey(chatId, messageId);
    const tasks = registry.get(key);
    if (!tasks) return;
    tasks.delete(taskId);
    if (tasks.size === 0) registry.delete(key);
};

const retainAsyncTasks = (
    registry: Map<string, Set<string>>,
    chatId: number,
    messageId: number,
    currentRevision: AsyncFileTaskRevision,
    retainedTaskIds: readonly string[]
): void => {
    const key = fileSaveKey(chatId, messageId);
    const retained = new Set(retainedTaskIds);
    const tasks = registry.get(key);
    if (!tasks) return;
    for (const taskId of tasks) {
        const taskRevision = taskRevisionOf(taskId);
        const belongsToNewerUpdate = taskRevision !== null
            && isRevisionAfter(taskRevision, currentRevision);
        if (!retained.has(taskId) && !belongsToNewerUpdate) tasks.delete(taskId);
    }
    if (tasks.size === 0) registry.delete(key);
};

export const isAsyncPreviewPending = (chatId: number, messageId: number): boolean =>
    (getAppState().asynchronousPreviewTasks.get(fileSaveKey(chatId, messageId))?.size ?? 0) > 0;

export const addAsyncPreviewTask = (chatId: number, messageId: number, taskId: string): void =>
    addAsyncTask(getAppState().asynchronousPreviewTasks, chatId, messageId, taskId);

export const removeAsyncPreviewTask = (chatId: number, messageId: number, taskId: string): void =>
    removeAsyncTask(getAppState().asynchronousPreviewTasks, chatId, messageId, taskId);

export const retainAsyncPreviewTasks = (
    chatId: number,
    messageId: number,
    currentRevision: AsyncFileTaskRevision,
    retainedTaskIds: readonly string[]
): void => retainAsyncTasks(
    getAppState().asynchronousPreviewTasks,
    chatId,
    messageId,
    currentRevision,
    retainedTaskIds
);

export const isAsyncOcrPending = (chatId: number, messageId: number): boolean =>
    (getAppState().asynchronousOcrTasks.get(fileSaveKey(chatId, messageId))?.size ?? 0) > 0;

export const addAsyncOcrTask = (chatId: number, messageId: number, taskId: string): void =>
    addAsyncTask(getAppState().asynchronousOcrTasks, chatId, messageId, taskId);

export const removeAsyncOcrTask = (chatId: number, messageId: number, taskId: string): void =>
    removeAsyncTask(getAppState().asynchronousOcrTasks, chatId, messageId, taskId);

export const retainAsyncOcrTasks = (
    chatId: number,
    messageId: number,
    currentRevision: AsyncFileTaskRevision,
    retainedTaskIds: readonly string[]
): void => retainAsyncTasks(
    getAppState().asynchronousOcrTasks,
    chatId,
    messageId,
    currentRevision,
    retainedTaskIds
);

// Edit monitor accessors
const MAX_PENDING_EDITS = 200;

export const markPendingEditWhileProcessing = (chatId: number, userMessageId: number): void => {
    const pending = getAppState().pendingEditsWhileProcessing;
    // Backstop against leaks from sessions that never finalize
    if (pending.size >= MAX_PENDING_EDITS) {
        const oldest = pending.values().next().value;
        if (oldest !== undefined) pending.delete(oldest);
    }
    pending.add(`${chatId}:${userMessageId}`);
};

export const consumePendingEditWhileProcessing = (chatId: number, userMessageId: number): boolean => {
    return getAppState().pendingEditsWhileProcessing.delete(`${chatId}:${userMessageId}`);
};

// Continuation registry accessors
export const registerContinuation = (chatId: number, continuationMsgId: number, firstMessageId: number): void => {
    const key = `${chatId}:${continuationMsgId}`;
    getAppState().continuationRegistry.set(key, firstMessageId);
};

export const unregisterContinuation = (chatId: number, continuationMsgId: number): void => {
    const key = `${chatId}:${continuationMsgId}`;
    getAppState().continuationRegistry.delete(key);
};

export const findFirstMessageIdByContinuation = (chatId: number, continuationMsgId: number): number | undefined => {
    const key = `${chatId}:${continuationMsgId}`;
    return getAppState().continuationRegistry.get(key);
};

// Idempotency guard accessors
const HANDLED_USER_MESSAGE_TTL_MS = 5 * 60 * 1000; // covers Telegram update re-delivery window
const MAX_HANDLED_USER_MESSAGES = 200;

/**
 * Try to claim handling rights for a user message.
 * Returns true when the caller wins the claim (should proceed), false when the
 * message is already being handled or was handled within the TTL (should skip).
 * Guards against Telegram update re-delivery and detached-handler re-entry.
 */
export const tryMarkUserMessageHandling = (chatId: number, userMessageId: number): boolean => {
    const state = getAppState();
    const now = Date.now();

    // Drop expired entries so the TTL window slides forward
    for (const [key, handledAt] of state.handledUserMessages) {
        if (now - handledAt > HANDLED_USER_MESSAGE_TTL_MS) {
            state.handledUserMessages.delete(key);
        }
    }

    const entryKey = `${chatId}:${userMessageId}`;
    if (state.handledUserMessages.has(entryKey)) {
        return false;
    }

    // Enforce max size by evicting the oldest entry
    if (state.handledUserMessages.size >= MAX_HANDLED_USER_MESSAGES) {
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        for (const [key, handledAt] of state.handledUserMessages) {
            if (handledAt < oldestTime) {
                oldestTime = handledAt;
                oldestKey = key;
            }
        }
        if (oldestKey) state.handledUserMessages.delete(oldestKey);
    }

    state.handledUserMessages.set(entryKey, now);
    return true;
};

// Context numbering accessors
const MAX_CONTEXT_NUMBERINGS = 200;

/**
 * Record the numbering of one assembled context, keyed by the user message the
 * reply answers. Retries and version switches overwrite the same key, so the
 * links rendered for a response always match the context it was built from.
 */
export const setContextNumbering = (
    chatId: number,
    userMessageId: number,
    numbering: Map<number, number>
): void => {
    const registry = getAppState().contextNumbering;
    const key = `${chatId}:${userMessageId}`;

    // Re-inserting at the end keeps eviction in insertion order
    registry.delete(key);
    if (registry.size >= MAX_CONTEXT_NUMBERINGS) {
        const oldest = registry.keys().next().value;
        if (oldest !== undefined) registry.delete(oldest);
    }

    registry.set(key, numbering);
};

/** Numbering of the given reply's context, or undefined once evicted */
export const getContextNumbering = (
    chatId: number,
    userMessageId: number
): Map<number, number> | undefined =>
    getAppState().contextNumbering.get(`${chatId}:${userMessageId}`);

// Replies currently being generated
// A session that never finalizes (crash, kill) would leave its entry behind, so
// entries older than the TTL are ignored when read.
const REPLY_IN_FLIGHT_TTL_MS = 10 * 60 * 1000;

/** Mark a user message as being answered right now */
export const registerReplyInFlight = (chatId: number, userMessageId: number): void => {
    getAppState().repliesInFlight.set(`${chatId}:${userMessageId}`, Date.now());
};

/** Drop the mark once the reply for that message is done (or failed) */
export const unregisterReplyInFlight = (chatId: number, userMessageId: number): void => {
    getAppState().repliesInFlight.delete(`${chatId}:${userMessageId}`);
};

/**
 * User messages of this chat whose reply is still being generated. Used when
 * assembling another reply's context, so a second trigger does not answer a
 * question that is already being answered.
 */
export const getRepliesInFlight = (chatId: number): number[] => {
    const registry = getAppState().repliesInFlight;
    const now = Date.now();
    const messageIds: number[] = [];

    for (const [key, startedAt] of registry) {
        if (now - startedAt > REPLY_IN_FLIGHT_TTL_MS) {
            registry.delete(key);
            continue;
        }
        const [, rawMessageId] = key.split(':');
        const messageId = Number(rawMessageId);
        if (Number.isSafeInteger(messageId) && key.startsWith(`${chatId}:`)) {
            messageIds.push(messageId);
        }
    }

    return messageIds;
};

/** Mark a bot reply message as being generated right now */
export const registerBotReplyInFlight = (chatId: number, messageId: number): void => {
    getAppState().botRepliesInFlight.set(`${chatId}:${messageId}`, Date.now());
};

/** Drop the mark once that reply's content has been stored */
export const unregisterBotReplyInFlight = (chatId: number, messageId: number): void => {
    getAppState().botRepliesInFlight.delete(`${chatId}:${messageId}`);
};

/**
 * Whether this bot message is still being written by a live session.
 *
 * A reply's stored row carries no text until finalize, so another context that
 * includes the reply mid-stream would otherwise see an empty turn and report it
 * as lost. The registry is what tells the two apart.
 */
export const isBotReplyInFlight = (chatId: number, messageId: number): boolean => {
    const registry = getAppState().botRepliesInFlight;
    const key = `${chatId}:${messageId}`;
    const startedAt = registry.get(key);
    if (startedAt === undefined) return false;
    if (Date.now() - startedAt > REPLY_IN_FLIGHT_TTL_MS) {
        registry.delete(key);
        return false;
    }
    return true;
};

// Retry and continue claims
// Between a click and the PROCESSING write there are several awaits, so a
// database check alone lets two fast clicks both start a run. The claim is
// checked and taken in one synchronous step instead. It has no expiry: its
// holder releases it in a finally once the run has ended.

/**
 * Take the claim on starting a new version of a reply (retry or continue).
 * Returns false when another click holds it. Call it right after looking up
 * the reply, with no await between that lookup's check and this call.
 */
export const tryClaimReplyRerun = (chatId: number, firstMessageId: number): boolean => {
    const claims = getAppState().replyRerunClaims;
    const key = `${chatId}:${firstMessageId}`;
    if (claims.has(key)) return false;
    claims.set(key, Date.now());
    return true;
};

/** Give the claim back once the run it was taken for has ended (or never started) */
export const releaseReplyRerun = (chatId: number, firstMessageId: number): void => {
    getAppState().replyRerunClaims.delete(`${chatId}:${firstMessageId}`);
};

/** Whether a retry or continue of this reply is being started or running right now */
export const isReplyRerunClaimed = (chatId: number, firstMessageId: number): boolean =>
    getAppState().replyRerunClaims.has(`${chatId}:${firstMessageId}`);

// Resumable marks
// The single truth of whether a reply can be continued. The checkpoint itself
// lives in the reply layer, which the services layer cannot import: so every
// finalization clears the reply's mark here, the reply layer sets it again
// after a failed or stopped finalization kept a checkpoint, and the checkpoint
// registry hands nothing out whose mark is gone. Expired marks are ignored when
// read, like the in-flight marks.

const resumableKey = (chatId: number, firstMessageId: number): string => `${chatId}:${firstMessageId}`;

/** This version of the reply can be continued until `mark.expiresAt` */
export const markReplyResumable = (chatId: number, firstMessageId: number, mark: ResumableMark): void => {
    getAppState().resumableMarks.set(resumableKey(chatId, firstMessageId), mark);
};

/**
 * The reply can no longer be continued. With `versionId`, only a mark on that
 * version is cleared: a newer one belongs to a later failure.
 */
export const clearReplyResumable = (chatId: number, firstMessageId: number, versionId?: number): void => {
    const marks = getAppState().resumableMarks;
    const key = resumableKey(chatId, firstMessageId);
    if (versionId !== undefined && marks.get(key)?.versionId !== versionId) return;
    marks.delete(key);
};

/** The reply's mark while it still counts; an expired one is dropped */
export const resumableMarkOf = (
    chatId: number,
    firstMessageId: number,
    now: number = Date.now()
): ResumableMark | undefined => {
    const marks = getAppState().resumableMarks;
    const key = resumableKey(chatId, firstMessageId);
    const mark = marks.get(key);
    if (mark === undefined) return undefined;
    if (now >= mark.expiresAt) {
        marks.delete(key);
        return undefined;
    }
    return mark;
};

/** How many replies can be continued right now (what a restart would drop) */
export const countResumableReplies = (now: number = Date.now()): number => {
    const marks = getAppState().resumableMarks;
    for (const [key, mark] of marks) {
        if (now >= mark.expiresAt) marks.delete(key);
    }
    return marks.size;
};

/**
 * Whether a reply's buttons offer "继续": only while the version on screen is
 * the marked one and also the latest version of the reply.
 */
export const showsResumableVersion = (
    chatId: number,
    firstMessageId: number,
    versions: readonly { readonly versionId: number }[],
    shownIndex: number
): boolean => {
    const mark = resumableMarkOf(chatId, firstMessageId);
    if (mark === undefined || shownIndex !== versions.length - 1) return false;
    return versions[shownIndex]?.versionId === mark.versionId;
};
