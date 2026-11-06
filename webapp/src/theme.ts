import type { TelegramWebApp } from './telegram';

// bg_color -> --tg-theme-bg-color
const cssVariableOf = (themeKey: string): string => `--tg-theme-${themeKey.replaceAll('_', '-')}`;

export const applyTheme = (webApp: TelegramWebApp): void => {
    const rootStyle = document.documentElement.style;
    for (const [themeKey, value] of Object.entries(webApp.themeParams)) {
        if (value !== undefined) rootStyle.setProperty(cssVariableOf(themeKey), value);
    }
    rootStyle.colorScheme = webApp.colorScheme;
    document.documentElement.dataset.colorScheme = webApp.colorScheme;
};

/** Applies the current theme and keeps following Telegram's theme switches for the page lifetime */
export const startThemeSync = (webApp: TelegramWebApp): void => {
    applyTheme(webApp);
    // The page background is secondary_bg_color (cards use bg_color), so match Telegram's chrome to it
    webApp.setHeaderColor('secondary_bg_color');
    webApp.setBackgroundColor('secondary_bg_color');
    webApp.onEvent('themeChanged', () => applyTheme(webApp));
};
