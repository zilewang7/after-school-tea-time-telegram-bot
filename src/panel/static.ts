/**
 * The built front end (webapp/dist) on the same port as the API (design §4.5).
 * Registered after every /api route, in this order:
 *  1. (app.ts) an unmatched /api/* is a JSON 404;
 *  2. /assets/* serves the hashed file, cached forever; a missing one is a
 *     plain 404 and never falls back to index.html (a stale page asking for a
 *     deleted chunk would get HTML and a MIME error);
 *  3. any other GET serves a real top-level file when there is one (Vite's
 *     public/ copies), else index.html — no-cache, with the CSP — so history
 *     routes such as /c/123 survive Telegram's "reload page";
 *  4. POST / PUT / PATCH / DELETE / OPTIONS are 405.
 * Without a build (dist/index.html missing) every GET is a 503 page: build.sh
 * has no `set -e`, so the bot starts even when the front-end build failed.
 */
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context, Hono } from 'hono';
import type { PanelEnv } from './context.js';

/** Resolved against the compiled file, dist/panel/static.js (src/panel/static.ts under tsx) */
export const DEFAULT_STATIC_ROOT = fileURLToPath(new URL('../../webapp/dist', import.meta.url));

export const INDEX_CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self' https://telegram.org",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
].join('; ');

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const NON_READ_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const INDEX_FILE = 'index.html';

const NOT_BUILT_PAGE = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>面板前端未构建</title></head>
<body><p>面板前端未构建</p></body>
</html>
`;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
};

const contentTypeOf = (filePath: string): string =>
    CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';

/** The file a URL path names inside root; null when it would escape root or is malformed */
const resolveInsideRoot = (root: string, urlPath: string): string | null => {
    let decodedPath: string;
    try {
        decodedPath = decodeURIComponent(urlPath);
    } catch {
        return null;
    }
    if (decodedPath.includes('\0')) return null;
    const resolvedPath = resolve(root, `.${decodedPath}`);
    return resolvedPath.startsWith(root + sep) ? resolvedPath : null;
};

const isRegularFile = async (filePath: string): Promise<boolean> => {
    try {
        return (await stat(filePath)).isFile();
    } catch {
        return false;
    }
};

const fileResponse = async (filePath: string, headers: Record<string, string>): Promise<Response> => {
    const content = await readFile(filePath);
    return new Response(new Uint8Array(content), {
        status: 200,
        headers: { 'Content-Type': contentTypeOf(filePath), ...headers },
    });
};

const notBuiltResponse = (context: Context<PanelEnv>): Response =>
    context.html(NOT_BUILT_PAGE, 503, { 'Cache-Control': 'no-store' });

const indexResponse = (root: string): Promise<Response> =>
    fileResponse(resolve(root, INDEX_FILE), {
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': INDEX_CONTENT_SECURITY_POLICY,
    });

export const registerStaticRoutes = (app: Hono<PanelEnv>, staticRoot: string): void => {
    const root = resolve(staticRoot);
    const indexPath = resolve(root, INDEX_FILE);
    const assetsRoot = resolve(root, 'assets');

    app.get('/assets/*', async (context) => {
        if (!(await isRegularFile(indexPath))) return notBuiltResponse(context);
        const filePath = resolveInsideRoot(root, context.req.path);
        const isAsset = filePath !== null && filePath.startsWith(assetsRoot + sep);
        if (!isAsset || !(await isRegularFile(filePath))) return context.text('Not Found', 404);
        return fileResponse(filePath, { 'Cache-Control': IMMUTABLE_CACHE });
    });

    app.get('*', async (context) => {
        if (!(await isRegularFile(indexPath))) return notBuiltResponse(context);
        const filePath = resolveInsideRoot(root, context.req.path);
        if (filePath !== null && filePath !== indexPath && (await isRegularFile(filePath))) {
            return fileResponse(filePath, { 'Cache-Control': 'no-cache' });
        }
        return indexResponse(root);
    });

    // Method-bound rather than app.all, so the request log can tell it from middleware
    app.on(NON_READ_METHODS, '*', (context) => context.text('Method Not Allowed', 405, { Allow: 'GET, HEAD' }));
};
