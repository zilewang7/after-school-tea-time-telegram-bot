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

interface RateLimiterEntry {
    count: number;
    startTimestamp: number;
    lastEditTimestamp: number;
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
    // rate limiter for message editing
    editRateLimiter: Record<number | string, RateLimiterEntry>;
    // edit monitor: "chatId:userMessageId" -> entry
    editMonitorMap: Map<string, EditMonitorEntry>;
    // bot instance for edit monitor
    editMonitorBot: Bot | null;
}

const createInitialState = (): AppStateType => ({
    currentModel: process.env.DEFAULT_MODEL || "gpt-5",
    mediaGroupIdTemp: {
        chatId: 0,
        messageId: 0,
        mediaGroupId: "",
    },
    asynchronousFileSaveMsgIdList: [],
    editRateLimiter: {},
    editMonitorMap: new Map(),
    editMonitorBot: null,
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

export const getEditRateLimiter = (): Record<number | string, RateLimiterEntry> =>
    getAppState().editRateLimiter;
export const getRateLimiterEntry = (chatId: number | string): RateLimiterEntry | undefined =>
    getAppState().editRateLimiter[chatId];
export const setRateLimiterEntry = (chatId: number | string, entry: RateLimiterEntry): void => {
    getAppState().editRateLimiter[chatId] = entry;
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
