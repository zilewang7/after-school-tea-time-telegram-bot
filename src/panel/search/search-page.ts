/**
 * The public Google-search fast page `GET /g/<token>` (design 2026-1113-1831 §3.5).
 *
 * One static HTML document, no framework, no script and no third-party
 * resource. Telegram's preview crawler does not run JS, so the whole card lives
 * in the head: the fixed title and, as its description, the same text the
 * chat's quote block holds — queries joined by ` | `, then one `[n] title` line
 * per source — HTML-escaped and not truncated (the caller asked for exactly
 * that text; the client truncates its own display).
 *
 * Every model- or user-derived string is escaped, and only http(s) URLs become
 * anchors, the same rule the chat formatter applies.
 */
import type {
    GoogleSearchBlockDocument,
    GoogleSearchQuery,
    GoogleSearchSource,
} from '../../telegram/formatters/google-search-document.js';
import { escapeHtml } from '../share/markdown-html.js';
import type { SearchPageRenderInput } from './search-types.js';

const BOT_NAME = 'k-on-bot';

/** The fixed preview-card title (design §3.4), next to the CoT page's 「点击查看思考过程」 */
export const SEARCH_PAGE_TITLE = '点击查看搜索过程';

/** No script and no network: the document itself and its inline style only */
export const SEARCH_PAGE_CSP = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
].join('; ');

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f2f3f5;
  --card: #ffffff;
  --text: #1a1a1a;
  --muted: #707579;
  --line: #e4e6e8;
  --accent: #2f7bd9;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1216;
    --card: #1b2027;
    --text: #e9edf1;
    --muted: #96a0aa;
    --line: #2c333d;
    --accent: #6aa9ef;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font: 16px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
    "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  -webkit-text-size-adjust: 100%;
}
.wrap { max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; }
.header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.label {
  font-weight: 700; font-size: 15px; letter-spacing: .02em; color: var(--text);
  background: var(--card); border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px;
}
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; margin-bottom: 14px; }
.meta .dot { opacity: .6; }
.block { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; margin-bottom: 12px; }
.block-title { margin: 0 0 8px; font-size: 15px; font-weight: 700; }
.queries { list-style: none; margin: 0; padding: 0; }
.query { padding: 1px 0; overflow-wrap: anywhere; }
.sources { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--line); }
.source { padding: 1px 0; font-size: 14px; overflow-wrap: anywhere; }
.source .num { color: var(--muted); margin-right: 4px; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.footer {
  margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--line);
  color: var(--muted); font-size: 13px;
}
.not-found { text-align: center; padding: 64px 16px; }
.not-found h1 { font-size: 20px; margin: 0 0 8px; }
.not-found p { color: var(--muted); margin: 0; }
`.trim();

const HTTP_URL_PATTERN = /^https?:\/\//i;

const formatTime = (iso: string): string => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(date);
};

/** Only real web links become anchors, exactly like the chat footer */
const anchorOf = (url: string, text: string): string => {
    const label = escapeHtml(text);
    if (!HTTP_URL_PATTERN.test(url)) return label;
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`;
};

const queryOf = (query: GoogleSearchQuery): string =>
    `<li class="query">${query.href === undefined ? escapeHtml(query.text) : anchorOf(query.href, query.text)}</li>`;

const sourceOf = (source: GoogleSearchSource): string =>
    `<div class="source"><span class="num">[${source.number}]</span>${anchorOf(source.uri, source.title)}</div>`;

const blockOf = (block: GoogleSearchBlockDocument): string =>
    [
        '<section class="block">',
        '<h2 class="block-title">GoogleSearch</h2>',
        block.queries.length === 0 ? '' : `<ul class="queries">${block.queries.map(queryOf).join('')}</ul>`,
        block.sources.length === 0 ? '' : `<div class="sources">${block.sources.map(sourceOf).join('')}</div>`,
        '</section>',
    ].join('');

const HEAD_START = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
].join('');

/** The card: fixed title, the quote block's text as its description, no image */
const headOf = (page: SearchPageRenderInput): string =>
    [
        HEAD_START,
        `<title>${SEARCH_PAGE_TITLE}</title>`,
        '<meta name="robots" content="noindex,nofollow">',
        '<meta property="og:type" content="article">',
        `<meta property="og:title" content="${SEARCH_PAGE_TITLE}">`,
        `<meta property="og:description" content="${escapeHtml(page.document.bodyText)}">`,
        `<meta property="og:site_name" content="${BOT_NAME}">`,
        // No og:image: the card is text-only by design (design §3.4)
        `<style>${STYLE}</style>`,
        '</head>',
    ].join('');

/** `共搜索 131 次` / `引用 3 条来源`, the same counts the chat's stat line uses */
const statsOf = (page: SearchPageRenderInput): string[] => {
    const parts: string[] = [];
    if (page.document.queryCount > 0) {
        parts.push(`共搜索 ${page.document.queryCount.toLocaleString('zh-CN')} 次`);
    }
    if (page.document.sourceCount > 0) {
        parts.push(`引用 ${page.document.sourceCount.toLocaleString('zh-CN')} 条来源`);
    }
    return parts;
};

/** `模型 · 11-13 18:31 · 共搜索 131 次 · 引用 3 条来源` */
const metaLineOf = (page: SearchPageRenderInput): string => {
    const parts: string[] = [];
    if (page.model !== null) parts.push(`<span>${escapeHtml(page.model)}</span>`);
    const time = formatTime(page.createdAt);
    if (time !== '') parts.push(`<span>${escapeHtml(time)}</span>`);
    for (const stats of statsOf(page)) parts.push(`<span>${escapeHtml(stats)}</span>`);
    const separator = '<span class="dot">·</span>';
    return `<div class="meta">${parts.join(separator)}</div>`;
};

/** The complete fast page */
export const renderSearchPage = (page: SearchPageRenderInput): string =>
    [
        headOf(page),
        '<body>',
        '<div class="wrap">',
        '<header class="header"><span class="label">搜索过程</span></header>',
        metaLineOf(page),
        '<main>',
        page.document.blocks.map(blockOf).join(''),
        '</main>',
        `<footer class="footer"><span>${BOT_NAME}</span></footer>`,
        '</div>',
        '</body>',
        '</html>',
    ].join('');

/** The page every unreadable token shows: same style, nothing about the token */
export const renderSearchNotFoundPage = (): string =>
    [
        HEAD_START,
        '<title>搜索过程不存在</title>',
        '<meta name="robots" content="noindex,nofollow">',
        `<style>${STYLE}</style>`,
        '</head>',
        '<body>',
        '<div class="wrap not-found">',
        '<h1>搜索过程不存在</h1>',
        '<p>这个链接无效，或者对应的搜索记录不存在。</p>',
        '</div>',
        '</body>',
        '</html>',
    ].join('');
