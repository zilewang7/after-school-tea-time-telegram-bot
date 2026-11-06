// localStorage can be unavailable or throw inside some WebViews; the panel must keep working without it.

export const readStorage = (key: string): string | null => {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
};

export const writeStorage = (key: string, value: string): void => {
    try {
        window.localStorage.setItem(key, value);
    } catch {
        // Ignore: drafts and last route are best-effort
    }
};

export const removeStorage = (key: string): void => {
    try {
        window.localStorage.removeItem(key);
    } catch {
        // Ignore: drafts and last route are best-effort
    }
};
