// Version-gated Telegram features. Every call degrades to a no-op (or "go ahead") on clients that lack it.

import type { TelegramWebApp } from './telegram';

const HAPTICS_VERSION = '6.1';
const POPUP_VERSION = '6.2';
const CLOSING_CONFIRMATION_VERSION = '6.2';
const VERTICAL_SWIPES_VERSION = '7.7';

export const supportsVersion = (webApp: TelegramWebApp, version: string): boolean =>
    typeof webApp.isVersionAtLeast === 'function' && webApp.isVersionAtLeast(version);

export const notifySuccessHaptic = (webApp: TelegramWebApp): void => {
    if (supportsVersion(webApp, HAPTICS_VERSION)) webApp.HapticFeedback.notificationOccurred('success');
};

/**
 * Telegram's native confirm dialog. Clients without popups go ahead unasked:
 * window.confirm is not reliable there (some WebViews answer false at once).
 */
export const confirmWithTelegram = (webApp: TelegramWebApp, message: string): Promise<boolean> => {
    if (!supportsVersion(webApp, POPUP_VERSION)) return Promise.resolve(true);
    return new Promise((resolve) => {
        try {
            webApp.showConfirm(message, (confirmed) => resolve(confirmed));
        } catch {
            // Another popup is already open (e.g. a double tap): treat as cancelled
            resolve(false);
        }
    });
};

/**
 * A setting that several mounted components may want at once (e.g. two editors);
 * it is switched on by the first holder and off again by the last one.
 */
const createSharedSwitch = (turnOn: () => void, turnOff: () => void) => {
    let holders = 0;
    return (): (() => void) => {
        holders += 1;
        if (holders === 1) turnOn();
        let released = false;
        return () => {
            if (released) return;
            released = true;
            holders -= 1;
            if (holders === 0) turnOff();
        };
    };
};

let verticalSwipeLock: (() => () => void) | null = null;
let closingConfirmation: (() => () => void) | null = null;

/** Stops the swipe-down-to-close gesture until the returned release is called */
export const holdVerticalSwipeLock = (webApp: TelegramWebApp): (() => void) => {
    if (!supportsVersion(webApp, VERTICAL_SWIPES_VERSION)) return () => undefined;
    verticalSwipeLock ??= createSharedSwitch(
        () => webApp.disableVerticalSwipes(),
        () => webApp.enableVerticalSwipes()
    );
    return verticalSwipeLock();
};

/** Asks before the panel closes until the returned release is called */
export const holdClosingConfirmation = (webApp: TelegramWebApp): (() => void) => {
    if (!supportsVersion(webApp, CLOSING_CONFIRMATION_VERSION)) return () => undefined;
    closingConfirmation ??= createSharedSwitch(
        () => webApp.enableClosingConfirmation(),
        () => webApp.disableClosingConfirmation()
    );
    return closingConfirmation();
};
