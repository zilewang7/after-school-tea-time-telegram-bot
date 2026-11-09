/**
 * 1200x630 share preview card — the `og:image` Telegram turns into a large
 * photo preview. Content priority is decided here: widget snapshot first, then
 * an image attachment, then a text excerpt.
 *
 * The card is a complete HTML document and is rendered by the same sidecar
 * client as widgets (width 1200). It is also exported as a pure string builder
 * so the layout and priority rules can be asserted without a renderer.
 */
import { sniffImageMime } from '../ai/image-generation/image-mime.js';
import { renderWidgetPng, type RenderResult } from './render-client.js';

export interface ShareCardInput {
    /** Card headline */
    readonly title: string;
    /** Optional line under the headline */
    readonly subtitle?: string;
    /** Bottom-left line, usually "<chat title> · <local time>" */
    readonly footer?: string;
    /** Rendered widget snapshot (preferred content) */
    readonly widgetPng?: Buffer;
    /** Image attachment (content fallback) */
    readonly imagePng?: Buffer;
    /** Text excerpt (last-resort content) */
    readonly textExcerpt?: string;
}

/** og:image dimensions Telegram was measured with (see the 2026-11-09 design §2.2) */
export const SHARE_CARD_WIDTH = 1200;
export const SHARE_CARD_HEIGHT = 630;

/** Keep the inlined base64 well under the sidecar's 300 KB body limit */
const MAX_INLINE_IMAGE_BYTES = 180 * 1024;
const MAX_TITLE_CHARS = 120;
const MAX_SUBTITLE_CHARS = 80;
const MAX_FOOTER_CHARS = 120;
const MAX_EXCERPT_CHARS = 180;

const HTML_ESCAPES: Readonly<Record<string, string>> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);

/** Truncate by code points, so an emoji is never cut in half */
const truncate = (text: string, maxChars: number): string => {
    const characters = Array.from(text);
    if (characters.length <= maxChars) return text;
    return `${characters.slice(0, maxChars).join('')}…`;
};

/** A data URI for a small image, or null when it is too large or not an image */
const inlineImageDataUri = (image: Buffer | undefined): string | null => {
    if (image === undefined || image.length === 0 || image.length > MAX_INLINE_IMAGE_BYTES) return null;
    const mime = sniffImageMime(image);
    if (mime === null) return null;
    return `data:${mime};base64,${image.toString('base64')}`;
};

const contentHtml = (input: ShareCardInput): string => {
    const snapshot = inlineImageDataUri(input.widgetPng) ?? inlineImageDataUri(input.imagePng);
    if (snapshot !== null) return `<img class="shot" src="${snapshot}" alt="">`;
    if (input.textExcerpt !== undefined && input.textExcerpt.trim() !== '') {
        return `<blockquote class="excerpt">${escapeHtml(truncate(input.textExcerpt, MAX_EXCERPT_CHARS))}</blockquote>`;
    }
    return '';
};

const CARD_STYLE = [
    '*,*::before,*::after{box-sizing:border-box}',
    'html,body{margin:0;padding:0;width:1200px;height:630px;overflow:hidden}',
    'body{display:flex;flex-direction:column;padding:28px 52px 26px;color:#eef4fb;',
    'font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans CJK SC","Noto Sans SC",sans-serif;',
    '-webkit-font-smoothing:antialiased;',
    'background:radial-gradient(1200px 500px at 82% -10%,rgba(78,161,255,.30),transparent 60%),',
    'radial-gradient(900px 420px at 8% 110%,rgba(64,224,208,.16),transparent 62%),',
    'linear-gradient(135deg,#0a1727 0%,#12263f 55%,#1b3a5c 100%)}',
    '.head{flex:0 0 auto}',
    '.brand{display:flex;align-items:center;gap:10px;font-size:18px;font-weight:700;letter-spacing:.3px;color:#9fc6f0}',
    '.brand-dot{width:11px;height:11px;border-radius:50%;background:#4ea1ff;box-shadow:0 0 14px rgba(78,161,255,.9)}',
    '.title{margin:14px 0 0;font-size:36px;line-height:1.22;font-weight:800;color:#fff;word-break:break-word;',
    'display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}',
    '.subtitle{margin:8px 0 0;font-size:18px;color:#a9bed6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.content{flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;margin:16px 0 0;overflow:hidden}',
    '.shot{max-width:1040px;max-height:100%;object-fit:contain;border-radius:14px;box-shadow:0 20px 50px rgba(0,0,0,.45)}',
    '.excerpt{max-width:1040px;max-height:100%;overflow:hidden;margin:0;padding:2px 0 2px 24px;',
    'border-left:6px solid #4ea1ff;font-size:27px;line-height:1.5;color:#dfe9f5;white-space:pre-wrap;word-break:break-word}',
    '.foot{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:24px;margin-top:16px;',
    'font-size:16px;color:#8fa6bd}',
    '.foot-left{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
    '.foot-right{flex:0 0 auto;color:#6f87a0;letter-spacing:.4px}',
].join('');

/** The card as a standalone 1200x630 document (pure: no renderer needed) */
export const buildShareCardHtml = (input: ShareCardInput): string => {
    const title = escapeHtml(truncate(input.title, MAX_TITLE_CHARS));
    const subtitle =
        input.subtitle === undefined || input.subtitle.trim() === ''
            ? ''
            : `<p class="subtitle">${escapeHtml(truncate(input.subtitle, MAX_SUBTITLE_CHARS))}</p>`;
    const footer =
        input.footer === undefined || input.footer.trim() === ''
            ? ''
            : `<span class="foot-left">${escapeHtml(truncate(input.footer, MAX_FOOTER_CHARS))}</span>`;
    return (
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
        `<style>${CARD_STYLE}</style></head><body>` +
        '<header class="head"><div class="brand"><span class="brand-dot"></span>k-on-bot · 对话分享</div>' +
        `<h1 class="title">${title}</h1>${subtitle}</header>` +
        `<main class="content">${contentHtml(input)}</main>` +
        `<footer class="foot">${footer}<span class="foot-right">k-on-bot</span></footer>` +
        '</body></html>'
    );
};

/**
 * Render the share card to a 1200x630 PNG; null when the renderer is off or
 * fails (the caller then falls back to the 600-wide widget image, or to no
 * og:image at all).
 */
export const renderShareCard = async (input: ShareCardInput): Promise<RenderResult | null> => {
    const result = await renderWidgetPng(buildShareCardHtml(input), {
        width: SHARE_CARD_WIDTH,
        scale: 1,
        theme: 'dark',
    });
    if (result === null) return null;
    if (result.width !== SHARE_CARD_WIDTH || result.height !== SHARE_CARD_HEIGHT) {
        console.warn(
            `[widget-image] share card is ${result.width}x${result.height}, expected ${SHARE_CARD_WIDTH}x${SHARE_CARD_HEIGHT}`
        );
    }
    return result;
};
