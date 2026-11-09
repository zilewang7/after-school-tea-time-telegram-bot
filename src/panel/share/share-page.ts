/**
 * The public share page (design §5.7): a plain server-rendered HTML document,
 * no framework, no third-party resources. Telegram's crawler does not run JS,
 * so everything its preview needs (title, description, and the widget render as
 * og:image when there is one) is in the initial HTML.
 *
 * Security: every user/model string is escaped, markdown only maps the
 * whitelisted entities (markdown-html.ts), widgets only load in a sandboxed
 * iframe from our own origin, media only from the share's own media route.
 */
import { escapeHtml, markdownExcerpt, markdownToHtml } from './markdown-html.js';
import type {
    ShareContent,
    ShareConversationContent,
    ShareFileContent,
    ShareReplyContent,
    ShareUserBubble,
    ShareWidgetContent,
} from './share-content.js';

/** Where the iframe loads its document from (relative: the page is same-origin) */
const widgetSrc = (token: string, index: number): string => `/s/${token}/widget/${index}`;

const mediaSrc = (token: string, messageId: number, slot: 'image' | 'file'): string =>
    `/s/${token}/media/${messageId}/${slot}`;

const OG_DESCRIPTION_MAX = 170;
const BOT_NAME = 'k-on-bot';

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

const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f2f3f5;
  --card: #ffffff;
  --card-soft: #f6f7f9;
  --text: #1a1a1a;
  --muted: #707579;
  --line: #e4e6e8;
  --accent: #2f7bd9;
  --user-bg: #e7f0fb;
  --bot-bg: #ffffff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1216;
    --card: #1b2027;
    --card-soft: #232932;
    --text: #e9edf1;
    --muted: #96a0aa;
    --line: #2c333d;
    --accent: #6aa9ef;
    --user-bg: #1d2b3c;
    --bot-bg: #1b2027;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
    "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  -webkit-text-size-adjust: 100%;
}
.wrap { max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; }
.page-header { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
.brand {
  font-weight: 700; font-size: 15px; letter-spacing: .02em; color: var(--text);
  background: var(--card); border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px;
}
.chat-title { color: var(--muted); font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bubble {
  border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; margin-bottom: 14px;
  box-shadow: 0 1px 2px rgba(0,0,0,.04);
}
.bubble.bot { background: var(--bot-bg); border-bottom-left-radius: 4px; }
.bubble.user { background: var(--user-bg); border-bottom-right-radius: 4px; }
.bubble-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.author { font-weight: 600; font-size: 14px; }
.time { color: var(--muted); font-size: 12px; }
.md { white-space: pre-wrap; overflow-wrap: anywhere; }
.md strong { font-weight: 700; }
.md a { color: var(--accent); text-decoration: none; }
.md a:hover { text-decoration: underline; }
.md code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .9em;
  background: var(--card-soft); border: 1px solid var(--line); border-radius: 5px; padding: 1px 5px;
}
.md pre { background: var(--card-soft); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
.md pre code { background: none; border: 0; padding: 0; }
.md blockquote { margin: 6px 0; padding: 2px 12px; border-left: 3px solid var(--line); color: var(--muted); }
.md blockquote.expandable { border-left-style: dashed; }
.md .tg-spoiler { background: var(--muted); color: transparent; border-radius: 4px; padding: 0 2px; }
.md .tg-spoiler:hover { color: inherit; background: var(--card-soft); }
figure { margin: 10px 0 0; }
figure img { display: block; max-width: 100%; height: auto; border-radius: 10px; border: 1px solid var(--line); }
figure iframe {
  display: block; width: 100%; min-height: 120px; height: 600px; border: 1px solid var(--line);
  border-radius: 10px; background: transparent;
}
figcaption { color: var(--muted); font-size: 13px; margin-top: 6px; }
.file {
  display: inline-flex; align-items: center; gap: 8px; margin-top: 10px; padding: 8px 12px;
  background: var(--card-soft); border: 1px solid var(--line); border-radius: 10px; font-size: 14px;
}
.media-hint { display: inline-block; margin-top: 6px; color: var(--muted); font-size: 12px; }
.empty { color: var(--muted); font-style: italic; }
.page-footer {
  margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--line); color: var(--muted);
  font-size: 13px; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; justify-content: space-between;
}
.miniapp {
  display: inline-block; padding: 8px 14px; border-radius: 999px; background: var(--accent);
  color: #fff; text-decoration: none; font-size: 14px; font-weight: 600;
}
.not-found { text-align: center; padding: 64px 16px; }
.not-found h1 { font-size: 20px; margin: 0 0 8px; }
.not-found p { color: var(--muted); margin: 0; }
`.trim();

/** The iframe height report handler; our own script, never the widget's */
const HEIGHT_SCRIPT = `
<script>
(() => {
  const frames = Array.from(document.querySelectorAll('iframe.widget'));
  const clamp = (value) => Math.max(120, Math.min(1600, Math.round(value)));
  addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'k-on-bot:widget-height') return;
    for (const frame of frames) {
      if (frame.contentWindow === event.source) frame.style.height = clamp(Number(data.height)) + 'px';
    }
  });
})();
</script>
`.trim();

/** The stored `/s/<token>/og.png` and its pixel size */
export interface SharePreviewInput {
    /** Pixel size of the stored image; null when the row predates the dimensions */
    width: number | null;
    height: number | null;
}

export interface SharePageInput {
    token: string;
    /** Absolute public origin, no trailing slash (OG URLs must be absolute) */
    baseUrl: string;
    content: ShareContent;
    /** The widget render `/s/<token>/og.png` serves; null = the page has no image */
    preview: SharePreviewInput | null;
    /** Mini App deep link, when BOT_USER_NAME is configured */
    miniAppLink: string | null;
}

interface PageMeta {
    title: string;
    description: string;
}

const replyMeta = (content: ShareReplyContent): PageMeta => {
    const chatLabel = content.chatTitle ?? '对话';
    const excerpt =
        markdownExcerpt(content.text, OG_DESCRIPTION_MAX) ||
        markdownExcerpt(content.widget?.caption ?? '', OG_DESCRIPTION_MAX) ||
        `来自 ${BOT_NAME} 的对话分享`;
    return { title: `${chatLabel} · bot 回复`, description: excerpt };
};

/** Room the "N 条消息 · " prefix takes inside the description budget */
const COUNT_PREFIX_MAX = 16;

const conversationMeta = (content: ShareConversationContent): PageMeta => {
    const chatLabel = content.chatTitle ?? '对话';
    const newest = [...content.bubbles].reverse().find((bubble) => bubble.text !== '');
    const excerpt =
        newest === undefined ? '' : markdownExcerpt(newest.text, OG_DESCRIPTION_MAX - COUNT_PREFIX_MAX);
    return {
        title: `${chatLabel} · 对话分享`,
        description: excerpt === '' ? `来自 ${BOT_NAME} 的对话分享` : `${content.bubbles.length} 条消息 · ${excerpt}`,
    };
};

const metaOf = (content: ShareContent): PageMeta =>
    content.kind === 'reply' ? replyMeta(content) : conversationMeta(content);

/** The image tags: the widget render and its real size, nothing else */
const ogImageTags = (imageUrl: string, preview: SharePreviewInput | null): string[] => {
    if (preview === null) return [];
    const dimensions =
        preview.width === null || preview.height === null
            ? []
            : [
                  `<meta property="og:image:width" content="${preview.width}">`,
                  `<meta property="og:image:height" content="${preview.height}">`,
              ];
    return [
        `<meta property="og:image" content="${escapeHtml(imageUrl)}">`,
        ...dimensions,
        `<meta name="twitter:image" content="${escapeHtml(imageUrl)}">`,
    ];
};

const headOf = (input: SharePageInput, meta: PageMeta): string => {
    const shareUrl = `${input.baseUrl}/s/${input.token}`;
    const imageUrl = `${shareUrl}/og.png`;
    const ogImage = ogImageTags(imageUrl, input.preview);
    return [
        '<!doctype html>',
        '<html lang="zh-CN">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        `<title>${escapeHtml(meta.title)}</title>`,
        `<meta name="description" content="${escapeHtml(meta.description)}">`,
        '<meta name="robots" content="noindex,nofollow">',
        '<meta property="og:type" content="article">',
        `<meta property="og:title" content="${escapeHtml(meta.title)}">`,
        `<meta property="og:description" content="${escapeHtml(meta.description)}">`,
        `<meta property="og:url" content="${escapeHtml(shareUrl)}">`,
        `<meta property="og:site_name" content="${BOT_NAME}">`,
        ...ogImage,
        '<meta name="twitter:card" content="summary_large_image">',
        `<meta name="twitter:title" content="${escapeHtml(meta.title)}">`,
        `<meta name="twitter:description" content="${escapeHtml(meta.description)}">`,
        `<style>${STYLE}</style>`,
        '</head>',
        '<body>',
    ].join('');
};

const widgetFigure = (token: string, index: number, widget: ShareWidgetContent): string => {
    const caption = widget.caption === null || widget.caption === '' ? '' : `<figcaption>${escapeHtml(widget.caption)}</figcaption>`;
    return [
        '<figure class="widget">',
        `<iframe class="widget" src="${escapeHtml(widgetSrc(token, index))}" sandbox="allow-scripts" loading="lazy" title="卡片"></iframe>`,
        caption,
        '</figure>',
    ].join('');
};

const imageFigure = (token: string, messageId: number, alt: string): string =>
    [
        '<figure class="image">',
        `<img src="${escapeHtml(mediaSrc(token, messageId, 'image'))}" alt="${escapeHtml(alt)}" loading="lazy">`,
        '</figure>',
    ].join('');

const fileChip = (file: ShareFileContent): string =>
    `<div class="file">📎 ${escapeHtml(file.name)} · ${escapeHtml(formatSize(file.sizeBytes))}</div>`;

const textBlock = (markdown: string, emptyLabel: string): string =>
    markdown === '' ? `<div class="md empty">${escapeHtml(emptyLabel)}</div>` : `<div class="md">${markdownToHtml(markdown)}</div>`;

/** One bot reply bubble; `widgetIndex` is the iframe order on this page */
const botBubble = (
    token: string,
    messageId: number,
    createdAt: string,
    text: string,
    widget: ShareWidgetContent | null,
    hasImage: boolean,
    file: ShareFileContent | null,
    widgetIndex: number | null
): string => {
    const attachments: string[] = [];
    if (widget !== null && widgetIndex !== null) attachments.push(widgetFigure(token, widgetIndex, widget));
    if (hasImage) attachments.push(imageFigure(token, messageId, '图片附件'));
    if (file !== null) attachments.push(fileChip(file));
    return [
        '<article class="bubble bot">',
        `<div class="bubble-head"><span class="author">${BOT_NAME}</span><span class="time">${escapeHtml(formatTime(createdAt))}</span></div>`,
        textBlock(text, '（无正文）'),
        ...attachments,
        '</article>',
    ].join('');
};

const userBubble = (token: string, bubble: ShareUserBubble): string => {
    const media = [
        bubble.hasImage ? imageFigure(token, bubble.messageId, '图片') : '',
        bubble.mediaHint === null ? '' : `<span class="media-hint">[${escapeHtml(bubble.mediaHint)}]</span>`,
    ].join('');
    return [
        '<article class="bubble user">',
        `<div class="bubble-head"><span class="author">${escapeHtml(bubble.authorName)}</span><span class="time">${escapeHtml(formatTime(bubble.createdAt))}</span></div>`,
        textBlock(bubble.text, '（无正文）'),
        media,
        '</article>',
    ].join('');
};

/** The reply page's single bubble */
const renderReplyBody = (input: SharePageInput, content: ShareReplyContent): string =>
    botBubble(
        input.token,
        content.firstMessageId,
        content.createdAt,
        content.text,
        content.widget,
        content.hasImage,
        content.file,
        content.widget === null ? null : 0
    );

/** The conversation page: bubbles in message order, widgets numbered as they appear */
const renderConversationBody = (input: SharePageInput, content: ShareConversationContent): string => {
    let widgetIndex = 0;
    return content.bubbles
        .map((bubble) => {
            if (bubble.kind === 'user') return userBubble(input.token, bubble);
            const index = bubble.widget === null ? null : widgetIndex++;
            return botBubble(
                input.token,
                bubble.messageId,
                bubble.createdAt,
                bubble.text,
                bubble.widget,
                bubble.hasImage,
                bubble.file,
                index
            );
        })
        .join('');
};

const footerOf = (input: SharePageInput, content: ShareContent): string => {
    const label = content.kind === 'reply' ? '这条回复' : '这段对话';
    const shareUrl = `${input.baseUrl}/s/${input.token}`;
    const miniApp =
        input.miniAppLink === null
            ? ''
            : `<a class="miniapp" href="${escapeHtml(input.miniAppLink)}" rel="noopener noreferrer">在 Telegram 打开 Mini App</a>`;
    return [
        '<footer class="page-footer">',
        `<span>由 ${BOT_NAME} 分享的${label} · <a href="${escapeHtml(shareUrl)}" rel="noopener">${escapeHtml(shareUrl)}</a></span>`,
        miniApp,
        '</footer>',
    ].join('');
};

/** The complete share page */
export const renderSharePage = (input: SharePageInput): string => {
    const meta = metaOf(input.content);
    const body =
        input.content.kind === 'reply'
            ? renderReplyBody(input, input.content)
            : renderConversationBody(input, input.content);
    const chatTitle = input.content.chatTitle;
    return [
        headOf(input, meta),
        '<div class="wrap">',
        '<header class="page-header">',
        `<span class="brand">${BOT_NAME}</span>`,
        chatTitle === null ? '' : `<span class="chat-title">${escapeHtml(chatTitle)}</span>`,
        '</header>',
        '<main>',
        body,
        '</main>',
        footerOf(input, input.content),
        '</div>',
        HEIGHT_SCRIPT,
        '</body>',
        '</html>',
    ].join('');
};

/** The page a bad or revoked token shows; same style, no content */
export const renderShareNotFoundPage = (): string =>
    [
        '<!doctype html>',
        '<html lang="zh-CN">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<meta name="robots" content="noindex,nofollow">',
        '<title>链接无效或已撤销</title>',
        `<style>${STYLE}</style>`,
        '</head>',
        '<body>',
        '<div class="wrap not-found">',
        '<h1>链接无效或已撤销</h1>',
        '<p>这个分享链接不存在，或者创建者已经撤销了它。</p>',
        '</div>',
        '</body>',
        '</html>',
    ].join('');
