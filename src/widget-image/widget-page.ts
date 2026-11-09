/**
 * Widget page wrapper: turns a widget HTML fragment into a complete document
 * for the renderer sidecar and for the Mini App iframe.
 *
 * The fragment comes from the A2UI compiler or from the model (HTML mode) and
 * assumes it is dropped inside a Telegram bubble: it reads `--tg-theme-*`
 * variables and expects the viewport width to be the bubble width. This module
 * supplies both, plus an optional height reporter so the iframe can size
 * itself to the content.
 */

export type WidgetTheme = 'light' | 'dark';

export interface WidgetDocumentOptions {
    /** Colour scheme; light when unset */
    readonly theme?: WidgetTheme;
    /** Inject the postMessage height reporter (Mini App iframe only) */
    readonly reportHeight?: boolean;
}

/**
 * Telegram theme values per colour scheme. Widgets style themselves with these
 * variables, so a light widget stays readable in dark mode.
 */
const THEME_VARIABLES: Readonly<Record<WidgetTheme, Readonly<Record<string, string>>>> = {
    light: {
        '--tg-theme-bg-color': '#ffffff',
        '--tg-theme-secondary-bg-color': '#f1f1f1',
        '--tg-theme-text-color': '#111111',
        '--tg-theme-hint-color': '#707579',
        '--tg-theme-link-color': '#2678b6',
        '--tg-theme-button-color': '#3390ec',
        '--tg-theme-button-text-color': '#ffffff',
        '--tg-theme-header-bg-color': '#ffffff',
        '--tg-theme-accent-text-color': '#168acd',
        '--tg-theme-section-bg-color': '#ffffff',
        '--tg-theme-section-header-text-color': '#707579',
        '--tg-theme-subtitle-text-color': '#707579',
        '--tg-theme-destructive-text-color': '#e53935',
    },
    dark: {
        '--tg-theme-bg-color': '#17212b',
        '--tg-theme-secondary-bg-color': '#232e3c',
        '--tg-theme-text-color': '#f5f5f5',
        '--tg-theme-hint-color': '#708499',
        '--tg-theme-link-color': '#6ab3f3',
        '--tg-theme-button-color': '#5288c1',
        '--tg-theme-button-text-color': '#ffffff',
        '--tg-theme-header-bg-color': '#17212b',
        '--tg-theme-accent-text-color': '#6ab3f3',
        '--tg-theme-section-bg-color': '#232e3c',
        '--tg-theme-section-header-text-color': '#708499',
        '--tg-theme-subtitle-text-color': '#708499',
        '--tg-theme-destructive-text-color': '#ff6b6b',
    },
};

/** A document already wrapped by a caller (e.g. the share card) is left alone */
const COMPLETE_DOCUMENT_PATTERN = /^\s*(?:<!doctype\s+html|<html[\s>])/i;

export const isCompleteHtmlDocument = (html: string): boolean => COMPLETE_DOCUMENT_PATTERN.test(html);

const themeVariablesCss = (theme: WidgetTheme): string =>
    Object.entries(THEME_VARIABLES[theme])
        .map(([name, value]) => `${name}:${value}`)
        .join(';');

/**
 * Base rules for the wrapper. The body must not set a width: the renderer's
 * viewport is the bubble width, and a content-box width would overflow it.
 */
const baseCss = (theme: WidgetTheme): string =>
    [
        '*,*::before,*::after{box-sizing:border-box}',
        'html,body{margin:0;padding:0}',
        `html{color-scheme:${theme}}`,
        'body{background:var(--tg-theme-bg-color);color:var(--tg-theme-text-color);',
        'font:15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans CJK SC","Noto Sans SC",sans-serif;',
        '-webkit-font-smoothing:antialiased;overflow-wrap:break-word}',
        'img,svg,canvas{max-width:100%}',
    ].join('');

/**
 * Height reporter for the Mini App iframe. It is injected into the head, i.e.
 * before the widget's own markup and scripts, and is self-contained: a widget
 * script that throws cannot stop it.
 */
const HEIGHT_REPORTER_SCRIPT = `(function () {
    if (window.parent === window) return;
    var lastHeight = 0;
    function measure() {
        var body = document.body;
        if (!body) return 0;
        return Math.ceil(Math.max(body.getBoundingClientRect().height, body.scrollHeight, 1));
    }
    function report() {
        var height = measure();
        if (height <= 0 || height === lastHeight) return;
        lastHeight = height;
        try {
            window.parent.postMessage({ type: 'k-on-bot:widget-height', height: height }, '*');
        } catch (error) {
            // a hostile parent origin only means no resize
        }
    }
    function watch() {
        report();
        if (typeof ResizeObserver === 'function' && document.body) {
            new ResizeObserver(report).observe(document.body);
        }
    }
    window.addEventListener('load', report);
    window.addEventListener('resize', report);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
    else watch();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(report);
    // Late layout shifts (async images, animations) settle within a few seconds
    var polls = 0;
    var timer = setInterval(function () {
        report();
        polls += 1;
        if (polls >= 20) clearInterval(timer);
    }, 250);
})();`;

const resolveTheme = (theme: WidgetTheme | undefined): WidgetTheme => (theme === 'dark' ? 'dark' : 'light');

/**
 * Wrap a widget fragment into a complete document. A complete document is
 * returned unchanged, so callers can pass either kind.
 */
export const widgetDocument = (html: string, options: WidgetDocumentOptions = {}): string => {
    if (isCompleteHtmlDocument(html)) return html;

    const theme = resolveTheme(options.theme);
    const style = `:root{${themeVariablesCss(theme)}}${baseCss(theme)}`;
    const reporter = options.reportHeight === true ? `<script>${HEIGHT_REPORTER_SCRIPT}</script>` : '';
    return (
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        `<style>${style}</style>${reporter}</head><body>${html}</body></html>`
    );
};
