/**
 * Application state singleton module
 * Replaces global variables with a typed state object
 */

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

interface AppStateType {
    // current AI model
    currentModel: string;
    // media group tracking
    mediaGroupIdTemp: MediaGroupIdTemp;
    // file saving queue
    asynchronousFileSaveMsgIdList: number[];
    // rate limiter for message editing
    editRateLimiter: Record<number | string, RateLimiterEntry>;
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
