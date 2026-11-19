/**
 * The public tool-call log fast page `GET /x/<token>` (design 2026-1119-1835
 * §13.2), the same static document as the GoogleSearch fast page (`/g/`).
 *
 * One HTML document, no framework, no script and no third-party resource.
 * Telegram's preview crawler does not run JS, so the whole card lives in the
 * head: the fixed title and, as its description, the usage line plus the first
 * ten call lines (the body keeps the whole log untruncated).
 *
 * The body carries exactly the lines `toolLogBodyLines` gives the chat block,
 * so the link message, the folded block and this page can never disagree. The
 * usage line is emphasized and every failed call line is marked.
 *
 * Every model-derived string is escaped; the lines are plain text, never HTML.
 */
import { toolLogBodyLines, toolLogStatsOf } from '../../telegram/formatters/tool-log-document.js';
import type { ToolLogDocument } from '../../telegram/formatters/tool-log-document.js';
import { escapeHtml } from '../../telegram/formatters/markdown-html.js';
import { truncateCodePoints } from '../../shared/tool-log.js';
import type { ToolLogPageRenderInput } from './tool-log-types.js';

const BOT_NAME = 'k-on-bot';

/** The fixed preview-card title (design §13.2), next to the search page's 「点击查看搜索过程」 */
export const TOOL_LOG_PAGE_TITLE = '点击查看工具调用';

/** Calls the card description lists before the ellipsis */
const OG_DESCRIPTION_CALL_LINES = 10;

/** Characters of the card description; the page itself is never truncated */
const OG_DESCRIPTION_MAX_CHARS = 500;

/** No script and no network: the document itself and its inline style only */
export const TOOL_LOG_PAGE_CSP = [
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
  --danger: #c0392b;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1216;
    --card: #1b2027;
    --text: #e9edf1;
    --muted: #96a0aa;
    --line: #2c333d;
    --accent: #6aa9ef;
    --danger: #ff7b72;
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
.wrap { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
.header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.label {
  font-weight: 700; font-size: 15px; letter-spacing: .02em; color: var(--text);
  background: var(--card); border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px;
}
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; margin-bottom: 14px; }
.meta .dot { opacity: .6; }
.log {
  background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 12px 16px;
}
.line {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 13.5px; line-height: 1.65;
  white-space: pre-wrap; overflow-wrap: anywhere;
  padding: 1px 0;
}
.line.usage { font-weight: 600; }
.line.failed { color: var(--danger); }
.line.note { color: var(--muted); }
.footer {
  margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--line);
  color: var(--muted); font-size: 13px;
}
.not-found { text-align: center; padding: 64px 16px; }
.not-found h1 { font-size: 20px; margin: 0 0 8px; }
.not-found p { color: var(--muted); margin: 0; }
`.trim();

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

/** The call lines the card's description lists: the numbered log, or the legacy lines of an old version */
const descriptionCallLinesOf = (document: ToolLogDocument): readonly string[] =>
    document.callLines.length > 0 ? document.callLines : document.legacyLines;

/** `usage line` + the first ten call lines + `…`; escaped by the caller, capped before escaping */
const ogDescriptionOf = (document: ToolLogDocument): string => {
    const callLines = descriptionCallLinesOf(document);
    const lines: string[] = [];
    if (document.usageLine !== '') lines.push(document.usageLine);
    lines.push(...callLines.slice(0, OG_DESCRIPTION_CALL_LINES));
    let text = lines.join('\n');
    if (callLines.length > OG_DESCRIPTION_CALL_LINES) text += '\n…';
    return truncateCodePoints(text, OG_DESCRIPTION_MAX_CHARS);
};

const HEAD_START = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
].join('');

/** The card: fixed title, the front of the log as its description, no image */
const headOf = (page: ToolLogPageRenderInput): string =>
    [
        HEAD_START,
        `<title>${TOOL_LOG_PAGE_TITLE}</title>`,
        '<meta name="robots" content="noindex,nofollow">',
        '<meta property="og:type" content="article">',
        `<meta property="og:title" content="${TOOL_LOG_PAGE_TITLE}">`,
        `<meta property="og:description" content="${escapeHtml(ogDescriptionOf(page.document))}">`,
        `<meta property="og:site_name" content="${BOT_NAME}">`,
        // No og:image: the card is text-only by design (design §13.2)
        `<style>${STYLE}</style>`,
        '</head>',
    ].join('');

/**
 * `共 4 次调用 · 1 次失败`, the counts of the block the page replaced; a
 * zero-failure log only claims its calls, and old versions have no usage to count.
 */
const statsOf = (document: ToolLogDocument): string[] => {
    const stats = toolLogStatsOf(document);
    if (stats.totalCalls === 0) return [];
    const calls = `共 ${stats.totalCalls.toLocaleString('zh-CN')} 次调用`;
    if (stats.failedCount === 0) return [calls];
    return [`${calls} · ${stats.failedCount.toLocaleString('zh-CN')} 次失败`];
};

/** `模型 · 11-19 18:31 · 共 4 次调用 · 1 次失败` (a zero-failure log stops at the call count) */
const metaLineOf = (page: ToolLogPageRenderInput): string => {
    const parts: string[] = [];
    if (page.model !== null) parts.push(`<span>${escapeHtml(page.model)}</span>`);
    const time = formatTime(page.createdAt);
    if (time !== '') parts.push(`<span>${escapeHtml(time)}</span>`);
    for (const stats of statsOf(page.document)) parts.push(`<span>${escapeHtml(stats)}</span>`);
    const separator = '<span class="dot">·</span>';
    return `<div class="meta">${parts.join(separator)}</div>`;
};

/** A numbered line's record, so a failed call is marked without parsing the text again */
const callIndexesFailedOf = (document: ToolLogDocument): ReadonlySet<number> =>
    new Set(document.calls.flatMap((call, index) => (call.failed === true ? [index] : [])));

const CALL_LINE_PATTERN = /^(\d+)\. /;
const TRUNCATION_NOTE_PATTERN = /^…另有 \d+ 次调用未记录$/;

const lineClassOf = (
    page: ToolLogPageRenderInput,
    line: string,
    failedIndexes: ReadonlySet<number>
): string => {
    const number = CALL_LINE_PATTERN.exec(line)?.[1];
    if (number !== undefined) {
        const callIndex = Number(number) - 1;
        return failedIndexes.has(callIndex) ? 'line failed' : 'line';
    }
    if (line !== '' && line === page.document.usageLine) return 'line usage';
    if (TRUNCATION_NOTE_PATTERN.test(line)) return 'line note';
    return 'line';
};

/** The whole log, one line per `<div>`; the page shows every call, never an excerpt */
const logHtmlOf = (page: ToolLogPageRenderInput): string => {
    const lines = toolLogBodyLines(page.document);
    if (lines.length === 0) return '';
    const failedIndexes = callIndexesFailedOf(page.document);
    const rows = lines.map(
        (line) => `<div class="${lineClassOf(page, line, failedIndexes)}">${escapeHtml(line)}</div>`
    );
    return `<section class="log">${rows.join('')}</section>`;
};

/** The complete fast page */
export const renderToolLogPage = (page: ToolLogPageRenderInput): string =>
    [
        headOf(page),
        '<body>',
        '<div class="wrap">',
        '<header class="header"><span class="label">工具调用</span></header>',
        metaLineOf(page),
        '<main>',
        logHtmlOf(page),
        '</main>',
        `<footer class="footer"><span>${BOT_NAME}</span></footer>`,
        '</div>',
        '</body>',
        '</html>',
    ].join('');

/** The page every unreadable token shows: same style, nothing about the token */
export const renderToolLogNotFoundPage = (): string =>
    [
        HEAD_START,
        '<title>工具调用不存在</title>',
        '<meta name="robots" content="noindex,nofollow">',
        `<style>${STYLE}</style>`,
        '</head>',
        '<body>',
        '<div class="wrap not-found">',
        '<h1>工具调用不存在</h1>',
        '<p>这个链接无效，或者对应的工具调用记录不存在。</p>',
        '</div>',
        '</body>',
        '</html>',
    ].join('');
