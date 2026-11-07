/**
 * Headers every response carries. No X-Frame-Options and no frame-ancestors:
 * Telegram Web embeds the panel in an iframe. The CSP itself is only set on
 * index.html (static.ts).
 */
import type { MiddlewareHandler } from 'hono';
import type { PanelEnv } from '../context.js';

export const securityHeaders: MiddlewareHandler<PanelEnv> = async (context, next) => {
    await next();
    context.header('X-Content-Type-Options', 'nosniff');
    context.header('Referrer-Policy', 'no-referrer');
    if (context.req.path === '/api' || context.req.path.startsWith('/api/')) {
        context.header('Cache-Control', 'no-store');
    }
};
