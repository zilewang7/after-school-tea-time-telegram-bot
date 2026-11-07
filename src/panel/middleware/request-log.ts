/**
 * One log line per request: `[panel] <METHOD> <route template> <status> <ms>ms u=<userId>`.
 * The route template (`/api/chats/:chatId`), never the concrete path, the
 * query or any header: initData must never reach a log.
 */
import type { MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';
import type { PanelContext, PanelEnv } from '../context.js';

/**
 * The route the request was meant for: the first matched route bound to a
 * method. Middleware is registered with `use` (method ALL) and every route,
 * catch-alls included, with explicit methods, so this is the endpoint even
 * when a middleware answered first (401, 429, 413). '-' when nothing matched.
 */
export const routeTemplateOf = (context: PanelContext): string =>
    matchedRoutes(context).find((route) => route.method !== 'ALL')?.path ?? '-';

export const requestLog: MiddlewareHandler<PanelEnv> = async (context, next) => {
    const startedAt = performance.now();
    await next();
    const elapsedMs = Math.round(performance.now() - startedAt);
    const userId = context.get('auth')?.user.id ?? '-';
    console.log(
        `[panel] ${context.req.method} ${routeTemplateOf(context)} ${context.res.status} ${elapsedMs}ms u=${userId}`
    );
};
