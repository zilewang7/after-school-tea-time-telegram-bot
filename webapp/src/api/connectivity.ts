// Tracks GET requests that are waiting to retry because the bot is unreachable; drives the top banner.

const pendingRetries = new Map<symbol, string>();
const listeners = new Set<() => void>();
let bannerMessage: string | null = null;

const publish = (): void => {
    const [firstMessage] = pendingRetries.values();
    bannerMessage = firstMessage ?? null;
    for (const listener of listeners) listener();
};

export const markUnreachable = (token: symbol, message: string): void => {
    pendingRetries.set(token, message);
    publish();
};

export const clearUnreachable = (token: symbol): void => {
    if (pendingRetries.delete(token)) publish();
};

export const subscribeConnectivity = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

/** Banner text while any GET is waiting to retry, otherwise null */
export const getConnectivityBanner = (): string | null => bannerMessage;
