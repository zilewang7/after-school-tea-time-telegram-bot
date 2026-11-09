/**
 * A `TelegramWebApp` stand-in for the browser login (design §8.2).
 *
 * The panel's components were written against the Mini App SDK; after a web
 * login the same app runs in a normal tab with a session cookie. This adapter
 * keeps the interface intact and degrades every Telegram-only capability:
 *
 * - `version: '0'` makes every `isVersionAtLeast` guard take its fallback path
 *   (share sheet → window.open, confirm → window.confirm), so features keep
 *   working instead of throwing;
 * - theme events are fed from `prefers-color-scheme`;
 * - header/background colour calls are no-ops (the page owns its own chrome).
 */
import type { TelegramBackButton, TelegramMainButton, TelegramThemeParams, TelegramWebApp } from './telegram';

const darkQuery = (): MediaQueryList | null =>
    typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

const noop = (): void => {
    // intentionally empty: the browser has no Telegram chrome to drive
};

const backButton: TelegramBackButton = { show: noop, hide: noop, onClick: noop, offClick: noop };
const mainButton: TelegramMainButton = {
    setText: noop,
    show: noop,
    hide: noop,
    enable: noop,
    disable: noop,
    showProgress: noop,
    hideProgress: noop,
    onClick: noop,
    offClick: noop,
};

export const createBrowserWebApp = (): TelegramWebApp => {
    const themeHandlers = new Set<() => void>();
    const query = darkQuery();
    const colorSchemeOf = (): 'light' | 'dark' => (query?.matches === true ? 'dark' : 'light');

    query?.addEventListener('change', () => {
        for (const handler of themeHandlers) handler();
    });

    const themeParams: TelegramThemeParams = {};

    return {
        initData: '',
        initDataUnsafe: {},
        themeParams,
        colorScheme: colorSchemeOf(),
        version: '0',
        isVersionAtLeast: () => false,
        ready: noop,
        expand: noop,
        close: () => window.close(),
        setHeaderColor: noop,
        setBackgroundColor: noop,
        showConfirm: (message, callback) => {
            callback?.(window.confirm(message));
        },
        enableClosingConfirmation: noop,
        disableClosingConfirmation: noop,
        enableVerticalSwipes: noop,
        disableVerticalSwipes: noop,
        BackButton: backButton,
        MainButton: mainButton,
        HapticFeedback: { notificationOccurred: noop },
        openTelegramLink: (url) => {
            window.open(url, '_blank', 'noopener,noreferrer');
        },
        openLink: (url) => {
            window.open(url, '_blank', 'noopener,noreferrer');
        },
        onEvent: (_eventType, handler) => {
            themeHandlers.add(handler);
        },
        offEvent: (_eventType, handler) => {
            themeHandlers.delete(handler);
        },
    };
};
