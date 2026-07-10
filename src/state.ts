/**
 * Application state singleton module
 * Replaces global variables with a typed state object
 */

import type { Bot } from 'grammy';

interface MediaGroupIdTemp {
    chatId: number;
    messageId: number;
    mediaGroupId: string;
}

interface EditMonitorEntry {
    firstMessageId: number;
    createdAt: number;
}

interface AppStateType {
    // current AI model
    currentModel: string;
    // media group tracking
    mediaGroupIdTemp: MediaGroupIdTemp;
    // file saving queue
    asynchronousFileSaveMsgIdList: number[];
    // link-preview fetching queue (kept separate from the media list: ids are
    // removed by filtering, so sharing one list would release the other waiter)
    asynchronousPreviewMsgIdList: number[];
    // edit monitor: "chatId:userMessageId" -> entry
    editMonitorMap: Map<string, EditMonitorEntry>;
    // bot instance for edit monitor
    editMonitorBot: Bot | null;
    // continuation message registry: "chatId:continuationMsgId" -> firstMessageId
    continuationRegistry: Map<string, number>;
    // idempotency guard: "chatId:userMessageId" -> handled-at timestamp (ms)
    handledUserMessages: Map<string, number>;
}

const createInitialState = (): AppStateType => ({
    currentModel: process.env.DEFAULT_MODEL || "gpt-5",
    mediaGroupIdTemp: {
        chatId: 0,
        messageId: 0,
        mediaGroupId: "",
    },
    asynchronousFileSaveMsgIdList: [],
    asynchronousPreviewMsgIdList: [],
    editMonitorMap: new Map(),
    editMonitorBot: null,
    continuationRegistry: new Map(),
    handledUserMessages: new Map(),
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

export const getAsyncFileSaveMsgIdList = (): number[] => getAppState().asynchronousFileSaveMsgIdList;
export const addAsyncFileSaveMsgId = (id: number): void => {
    getAppState().asynchronousFileSaveMsgIdList.push(id);
};
export const removeAsyncFileSaveMsgId = (id: number): void => {
    const state = getAppState();
    state.asynchronousFileSaveMsgIdList = state.asynchronousFileSaveMsgIdList.filter(
        (msgId) => msgId !== id
    );
};

export const getAsyncPreviewMsgIdList = (): number[] => getAppState().asynchronousPreviewMsgIdList;
export const addAsyncPreviewMsgId = (id: number): void => {
    getAppState().asynchronousPreviewMsgIdList.push(id);
};
export const removeAsyncPreviewMsgId = (id: number): void => {
    const state = getAppState();
    state.asynchronousPreviewMsgIdList = state.asynchronousPreviewMsgIdList.filter(
        (msgId) => msgId !== id
    );
};

// Edit monitor accessors
const ONE_HOUR_MS = 60 * 60 * 1000;
const MAX_MONITORED = 20;

export const getEditMonitorBot = (): Bot | null => getAppState().editMonitorBot;
export const setEditMonitorBot = (bot: Bot): void => {
    getAppState().editMonitorBot = bot;
};

export const getEditMonitorEntry = (chatId: number, userMessageId: number): EditMonitorEntry | undefined => {
    const key = `${chatId}:${userMessageId}`;
    return getAppState().editMonitorMap.get(key);
};

export const addEditMonitorEntry = (chatId: number, userMessageId: number, firstMessageId: number): void => {
    const state = getAppState();
    const now = Date.now();

    // Clean up expired entries
    for (const [key, entry] of state.editMonitorMap) {
        if (now - entry.createdAt > ONE_HOUR_MS) {
            state.editMonitorMap.delete(key);
        }
    }

    // Enforce max limit by removing oldest
    if (state.editMonitorMap.size >= MAX_MONITORED) {
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        for (const [key, entry] of state.editMonitorMap) {
            if (entry.createdAt < oldestTime) {
                oldestTime = entry.createdAt;
                oldestKey = key;
            }
        }
        if (oldestKey) state.editMonitorMap.delete(oldestKey);
    }

    const key = `${chatId}:${userMessageId}`;
    state.editMonitorMap.set(key, { firstMessageId, createdAt: now });
};

export const removeEditMonitorEntry = (chatId: number, userMessageId: number): void => {
    const key = `${chatId}:${userMessageId}`;
    getAppState().editMonitorMap.delete(key);
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
