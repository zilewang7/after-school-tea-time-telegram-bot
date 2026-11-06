/**
 * Server-side ceiling for one API handler (Cloudflare gives the origin 100s;
 * we answer 504 long before). The handler is not cancelled, only no longer
 * waited for.
 */
import type { MiddlewareHandler } from 'hono';
import type { PanelEnv } from '../context.js';
import { PANEL_MESSAGES, PanelError } from '../errors.js';

export const createHandlerTimeout =
    (timeoutMs: number): MiddlewareHandler<PanelEnv> =>
    async (_context, next) => {
        let timer: NodeJS.Timeout | undefined;
        const expired = new Promise<'expired'>((resolve) => {
            timer = setTimeout(() => resolve('expired'), timeoutMs);
        });
        try {
            const outcome = await Promise.race([next().then(() => 'done' as const), expired]);
            if (outcome === 'expired') throw new PanelError('timeout', PANEL_MESSAGES.timeout);
        } finally {
            clearTimeout(timer);
        }
    };
