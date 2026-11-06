/**
 * initData authentication for every /api route but /api/health.
 *
 * Reads the `X-Init-Data` header (never a query parameter), verifies it with
 * the age limit of the request kind — writes (PATCH / PUT / DELETE / POST,
 * except the settings preview) need initData from the last 5 minutes, reads
 * from the last 24 hours — and leaves the user and a fresh access resolver on
 * the context. A failure is logged by reason only; the header value is never
 * logged.
 */
import type { MiddlewareHandler } from 'hono';
import { isOwnerUser } from '../../config/owner.js';
import { touchPanelUserDebounced } from '../../db/queries/panel-registry.js';
import { createChatAccessResolver } from '../access/chat-access.js';
import type { MembershipChecker } from '../access/membership.js';
import { READ_MAX_AGE_SECONDS, WRITE_MAX_AGE_SECONDS, verifyInitData } from '../auth/init-data.js';
import type { PanelEnv } from '../context.js';
import { PANEL_MESSAGES, PanelError } from '../errors.js';
import type { PanelUser } from '../types.js';

export const INIT_DATA_HEADER = 'X-Init-Data';

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** POST that only renders and stores nothing, so it keeps the read window */
const PREVIEW_PATH = /^\/api\/chats\/[^/]+\/settings\/preview$/;

export const isWriteRequest = (method: string, path: string): boolean => {
    if (READ_METHODS.has(method)) return false;
    return !(method === 'POST' && PREVIEW_PATH.test(path));
};

export interface AuthMiddlewareOptions {
    botToken: string;
    checker: MembershipChecker;
    /** Clock in ms */
    now: () => number;
}

export const createAuthMiddleware =
    (options: AuthMiddlewareOptions): MiddlewareHandler<PanelEnv> =>
    async (context, next) => {
        const maxAgeSeconds = isWriteRequest(context.req.method, context.req.path)
            ? WRITE_MAX_AGE_SECONDS
            : READ_MAX_AGE_SECONDS;
        const verification = verifyInitData(context.req.header(INIT_DATA_HEADER), options.botToken, {
            maxAgeSeconds,
            nowSeconds: Math.floor(options.now() / 1000),
        });
        if (!verification.ok) {
            console.log(`[panel] auth rejected: ${verification.reason}`);
            throw new PanelError('unauthorized', PANEL_MESSAGES.unauthorized);
        }

        const verifiedUser = verification.data.user;
        const user: PanelUser = { ...verifiedUser, isOwner: isOwnerUser(verifiedUser.id) };
        // Display names of panel-only users come from here (60s debounce, never throws)
        touchPanelUserDebounced({
            id: user.id,
            first_name: user.firstName,
            last_name: user.lastName ?? undefined,
            username: user.username ?? undefined,
        });
        context.set('auth', {
            user,
            access: createChatAccessResolver(user, options.checker),
            startParam: verification.data.startParam,
        });
        await next();
    };
