/**
 * The SSR fast page `GET /t/<token>` (design §6.1).
 *
 * One static HTML document, no framework and no third-party resource. Telegram's
 * preview crawler does not run JS, so everything its card needs is in the head —
 * and that head deliberately carries no thinking text: the card is the fixed
 * title「点击查看思考过程」and the model name, never a CoT excerpt (design §6.1).
 * The text itself only lives in the body.
 *
 * A finished thinking is rendered as markdown through the share page's safe
 * renderer (whitelisted entities, every text piece escaped). A generating one is
 * pre-wrap text plus a 700ms `?after` poll that appends and sticks to the bottom;
 * once the stream ends the page reloads once and the reloaded, `data-done` page
 * is the rendered final version (and polls nothing, so it cannot loop).
 */
import { match } from 'ts-pattern';
import { escapeHtml, markdownToHtml } from '../share/markdown-html.js';
import type { ThinkingDocument, ThinkingStatus } from './thinking-types.js';

const BOT_NAME = 'k-on-bot';

/** The fixed card title (design §6.1) */
export const THINKING_PAGE_TITLE = '点击查看思考过程';

/** The page allows our own inline style/script and same-origin polling only */
export const THINKING_PAGE_CSP = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
].join('; ');

/** How often the generating page asks for the new tail (design §6.1) */
const POLL_INTERVAL_MS = 700;

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
main { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; }
.thinking { margin: 0; font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; }
.md { white-space: pre-wrap; overflow-wrap: anywhere; }
.md strong { font-weight: 700; }
.md a { color: var(--accent); text-decoration: none; }
.md a:hover { text-decoration: underline; }
.md code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .9em;
  background: var(--bg); border: 1px solid var(--line); border-radius: 5px; padding: 1px 5px;
}
.md pre { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
.md pre code { background: none; border: 0; padding: 0; }
.md blockquote { margin: 6px 0; padding: 2px 12px; border-left: 3px solid var(--line); color: var(--muted); }
.md blockquote.expandable { border-left-style: dashed; }
.md .tg-spoiler { background: var(--muted); color: transparent; border-radius: 4px; padding: 0 2px; }
.md .tg-spoiler:hover { color: inherit; background: var(--bg); }
.empty { color: var(--muted); font-size: 14px; margin: 0; }
.state { color: var(--muted); font-size: 13px; min-height: 1.2em; margin: 10px 0 0; }
.error {
  margin: 0 0 14px; padding: 8px 12px; background: var(--card); border: 1px solid var(--line);
  border-left: 3px solid #d9534f; border-radius: 8px; font-size: 14px;
}
.footer {
  margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--line);
  display: flex; flex-wrap: wrap; align-items: center; gap: 12px; justify-content: space-between;
  color: var(--muted); font-size: 13px;
}
.miniapp {
  display: inline-block; padding: 8px 14px; border-radius: 999px; background: var(--accent);
  color: #fff; text-decoration: none; font-size: 14px; font-weight: 600;
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

const statusLabelOf = (status: ThinkingStatus): string =>
    match(status)
        .with('generating', () => '生成中')
        .with('done', () => '已完成')
        .with('interrupted', () => '生成被中断')
        .with('unavailable', () => '没有思考内容')
        .exhaustive();

const statusClassOf = (status: ThinkingStatus): string => `status status-${status}`;

const HEAD_START = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
].join('');

/** The fixed card: title, model name, never an excerpt of the thinking (design §6.1) */
const headOf = (document: ThinkingDocument): string => {
    const model = document.model ?? BOT_NAME;
    return [
        HEAD_START,
        `<title>${THINKING_PAGE_TITLE}</title>`,
        '<meta name="robots" content="noindex,nofollow">',
        '<meta property="og:type" content="article">',
        `<meta property="og:title" content="${THINKING_PAGE_TITLE}">`,
        `<meta property="og:description" content="${escapeHtml(model)}">`,
        `<meta property="og:site_name" content="${BOT_NAME}">`,
        // No og:image: the card is text-only by design (design §6.1)
        `<style>${STYLE}</style>`,
        '</head>',
    ].join('');
};

/** `生成中 · gemini-4-argon · 11-11 03:25 · 12,345 字` */
const metaLine = (document: ThinkingDocument): string => {
    const parts: string[] = [
        `<span class="${statusClassOf(document.status)}">${escapeHtml(statusLabelOf(document.status))}</span>`,
    ];
    if (document.model !== null) parts.push(`<span>${escapeHtml(document.model)}</span>`);
    const time = formatTime(document.createdAt);
    if (time !== '') parts.push(`<span>${escapeHtml(time)}</span>`);
    if (document.text !== '') parts.push(`<span>${document.text.length.toLocaleString('zh-CN')} 字</span>`);
    const separator = '<span class="dot">·</span>';
    return `<div class="meta">${parts.join(separator)}</div>`;
};

const errorLineOf = (document: ThinkingDocument): string =>
    document.errorMessage === null ? '' : `<p class="error">⚠ ${escapeHtml(document.errorMessage)}</p>`;

const emptyBodyOf = (status: ThinkingStatus): string =>
    match(status)
        .with('interrupted', () => '<p class="empty">这次思考在生成过程中被中断，没有留下内容。</p>')
        .with('unavailable', () => '<p class="empty">这次回复没有可查看的思考过程。</p>')
        .otherwise(() => '<p class="empty">没有内容。</p>');

const bodyOf = (document: ThinkingDocument): string => {
    if (document.status === 'generating') {
        const text = document.text === '' ? '' : escapeHtml(document.text);
        return [
            `<pre class="thinking" id="thinking">${text}</pre>`,
            '<p class="state" id="state"></p>',
        ].join('');
    }
    if (document.text === '') return emptyBodyOf(document.status);
    return `<div class="md">${markdownToHtml(document.text)}</div>`;
};

/**
 * The incremental poll. `offset` starts at the length the server rendered, every
 * answer appends its delta, and the page sticks to the bottom unless the reader
 * scrolled up. Once the stream is done it reloads once to get the markdown
 * version; the sessionStorage guard is a safety net in case the stored version
 * is not readable yet during the first reload.
 */
const pollingScript = (token: string): string =>
    `
<script>
(() => {
  const token = ${JSON.stringify(token)};
  const thinking = document.getElementById('thinking');
  const state = document.getElementById('state');
  const reloadKey = 'thinking-reload:' + token;
  let offset = thinking === null ? 0 : thinking.textContent.length;
  let stick = true;
  const nearBottom = () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
  addEventListener('scroll', () => { stick = nearBottom(); }, { passive: true });
  const append = (text) => {
    if (thinking === null) return;
    thinking.textContent += text;
    if (stick) window.scrollTo(0, document.body.scrollHeight);
  };
  const finish = () => {
    let reloaded = false;
    try { reloaded = window.sessionStorage.getItem(reloadKey) === '1'; } catch (error) { reloaded = false; }
    if (reloaded) {
      if (state !== null) state.textContent = '思考已结束，刷新页面查看排版后的版本。';
      return;
    }
    try { window.sessionStorage.setItem(reloadKey, '1'); } catch (error) { /* storage may be off */ }
    window.location.reload();
  };
  const poll = async () => {
    try {
      const response = await fetch('/api/public/thinking/' + encodeURIComponent(token) + '?after=' + offset, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json();
      if (data.reset === true) {
        if (thinking !== null) thinking.textContent = typeof data.text === 'string' ? data.text : '';
        offset = typeof data.next === 'number' ? data.next : offset;
      } else if (typeof data.delta === 'string') {
        append(data.delta);
        offset = typeof data.next === 'number' ? data.next : offset + data.delta.length;
      }
      if (data.done === true) { finish(); return; }
      window.setTimeout(poll, ${POLL_INTERVAL_MS});
    } catch (error) {
      window.setTimeout(poll, 2000);
    }
  };
  window.setTimeout(poll, ${POLL_INTERVAL_MS});
})();
</script>
`.trim();

const footerOf = (miniAppLink: string | null): string => {
    const open =
        miniAppLink === null
            ? ''
            : `<a class="miniapp" href="${escapeHtml(miniAppLink)}" rel="noopener noreferrer">在 Telegram 中打开</a>`;
    return ['<footer class="footer">', `<span>${BOT_NAME}</span>`, open, '</footer>'].join('');
};

export interface ThinkingPageInput {
    document: ThinkingDocument;
    /** Mini App deep link of the footer button; null without BOT_USER_NAME */
    miniAppLink: string | null;
}

/** The complete fast page; `data-done` marks the rendered final state */
export const renderThinkingPage = (input: ThinkingPageInput): string => {
    const { document } = input;
    const done = document.done;
    return [
        headOf(document),
        `<body data-done="${done ? '1' : '0'}">`,
        '<div class="wrap">',
        '<header class="header"><span class="label">思考过程</span></header>',
        metaLine(document),
        errorLineOf(document),
        '<main>',
        bodyOf(document),
        '</main>',
        footerOf(input.miniAppLink),
        '</div>',
        done ? '' : pollingScript(document.row.token),
        '</body>',
        '</html>',
    ].join('');
};

/** The page an unknown (or otherwise unreadable) token shows; same style, no content */
export const renderThinkingNotFoundPage = (): string =>
    [
        HEAD_START,
        '<title>思考过程不存在</title>',
        '<meta name="robots" content="noindex,nofollow">',
        `<style>${STYLE}</style>`,
        '</head>',
        '<body>',
        '<div class="wrap not-found">',
        '<h1>思考过程不存在</h1>',
        '<p>这个链接无效，或者对应的思考没有留下内容。</p>',
        '</div>',
        '</body>',
        '</html>',
    ].join('');
