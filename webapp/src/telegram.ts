// Minimal typing of the Telegram Mini App SDK (telegram-web-app.js), limited to what the panel uses.

export type TelegramThemeParams = Partial<Record<string, string>>;

export interface TelegramBackButton {
    show(): void;
    hide(): void;
    onClick(callback: () => void): void;
    offClick(callback: () => void): void;
}

export interface TelegramMainButton {
    setText(text: string): void;
    show(): void;
    hide(): void;
    enable(): void;
    disable(): void;
    showProgress(leaveActive?: boolean): void;
    hideProgress(): void;
    onClick(callback: () => void): void;
    offClick(callback: () => void): void;
}

export interface TelegramInitDataUnsafe {
    // The SDK parses initData from the URL, so this arrives as a string in practice
    auth_date?: string | number;
    start_param?: string;
}

export interface TelegramWebApp {
    initData: string;
    initDataUnsafe: TelegramInitDataUnsafe;
    themeParams: TelegramThemeParams;
    colorScheme: 'light' | 'dark';
    ready(): void;
    expand(): void;
    close(): void;
    // Theme keywords follow theme switches by themselves; older clients only log a warning
    setHeaderColor(color: 'bg_color' | 'secondary_bg_color'): void;
    setBackgroundColor(color: 'bg_color' | 'secondary_bg_color'): void;
    BackButton: TelegramBackButton;
    MainButton: TelegramMainButton;
    onEvent(eventType: 'themeChanged', handler: () => void): void;
    offEvent(eventType: 'themeChanged', handler: () => void): void;
}

declare global {
    interface Window {
        Telegram?: {
            WebApp?: TelegramWebApp;
        };
    }
}

/**
 * The SDK also defines WebApp in a normal browser tab, just with empty initData,
 * so "inside Telegram" means the SDK is present and initData is non-empty.
 */
export const getTelegramWebApp = (): TelegramWebApp | null => {
    const webApp = window.Telegram?.WebApp;
    if (webApp === undefined || webApp.initData === '') return null;
    return webApp;
};

/** auth_date in unix seconds, or null when missing or malformed */
export const readAuthDate = (webApp: TelegramWebApp): number | null => {
    const raw = webApp.initDataUnsafe.auth_date;
    if (raw === undefined) return null;
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
};

export const readStartParam = (webApp: TelegramWebApp): string | null => {
    const startParam = webApp.initDataUnsafe.start_param;
    return startParam === undefined || startParam === '' ? null : startParam;
};
