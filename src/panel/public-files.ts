/**
 * The site's machine-readable declarations (design 2026-1124-0611 §4.3): a
 * real `/robots.txt` and `/llms.txt`, served in front of the static catch-all.
 *
 * They say how the AI agents a user starts may read a share link that user was
 * given; they do not allow indexing. The share page keeps its `noindex` meta
 * and `X-Robots-Tag` — declaring a read path is not the same as opening the
 * page to search engines (privacy hard rule, design §5.6).
 *
 * Both files are constants, independent of SHARE_ENABLED: a crawler should
 * always get a truthful declaration, and the share routes answer 404 when the
 * feature is off anyway.
 */
import type { Hono } from 'hono';
import type { PanelEnv } from './context.js';

/** Robots rules: search engines stay out, the on-demand AI agents may read one share */
export const ROBOTS_TXT = [
    '# k-on-bot 面板与公开页',
    'User-agent: *',
    'Allow: /',
    'Disallow: /s/',
    'Disallow: /t/',
    'Disallow: /g/',
    'Disallow: /x/',
    'Disallow: /w/',
    'Disallow: /m/',
    'Disallow: /api/',
    '',
    '# 用户主动发起读取的 AI agent：允许抓取用户已经拿到的分享链接本身',
    '# （分享页仍然 noindex：这里允许读取，不是允许索引）',
    'User-agent: GoogleAgent-URLContext',
    'Disallow: /',
    'Allow: /s/',
    'Allow: /api/public/shares/',
    '',
    'User-agent: Google-Agent',
    'Disallow: /',
    'Allow: /s/',
    '',
    'User-agent: Google-CloudVertexBot',
    'Disallow: /',
    'Allow: /s/',
    '',
    'User-agent: Gemini-Deep-Research',
    'Disallow: /',
    'Allow: /s/',
    '',
].join('\n');

/** A short llms.txt: what the share pages are and which read paths exist */
export const LLMS_TXT = [
    '# k-on-bot',
    '',
    '> 分享页是 capability URL：token 即权限，页面 noindex，不要索引或枚举。',
    '> 用户主动发起的 AI 读取（如 GoogleAgent-URLContext）允许读取分享链接本身。',
    '',
    '## 公开分享',
    '',
    '- HTML 页面：`/s/<token>`（SSR，含脱敏后的对话或 bot 回复）',
    '- JSON 视图：`/api/public/shares/<token>`（与页面相同的脱敏内容；不含 widget HTML 与媒体字节）',
    '- 媒体：`/s/<token>/media/<messageId>/<slot>`',
    '',
    '分享内容随原消息保留期（7 天）到期后 404；撤销后立即 404。',
    '',
].join('\n');

const TEXT_HEADERS: Readonly<Record<string, string>> = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
};

export const registerPublicFileRoutes = (app: Hono<PanelEnv>): void => {
    // Registered before the static catch-all, so these are files, not the SPA
    app.get('/robots.txt', (context) => context.text(ROBOTS_TXT, 200, { ...TEXT_HEADERS }));
    app.get('/llms.txt', (context) => context.text(LLMS_TXT, 200, { ...TEXT_HEADERS }));
};
