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
    // current AI model
    currentModel: string;
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
}

const createInitialState = (): AppStateType => ({
    currentModel: process.env.DEFAULT_MODEL || "gpt-5",
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
export const getCurrentModel = (): string => getAppState().currentModel;
export const setCurrentModel = (model: string): void => {
    getAppState().currentModel = model;
};

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
