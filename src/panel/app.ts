/**
 * The panel's hono app: the API under /api and the built front end.
 *
 * Per API request (design §7): body limit (413) → initData (401) → per-user
 * rate limit (429) → handler under a 30s ceiling (504), whose access check
 * (403 / 503) comes before its parameter checks (400). /api/health sits in
 * front of all of it. Every response gets the security headers and one log
 * line.
 *
 * Built without I/O: offline cases drive it through `app.request()` with a
 * fake membership lookup and a scratch static root.
 */
import { Api } from 'grammy';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMembershipChecker, type MembershipLookup } from './access/membership.js';
import type { ChatNameLookup } from './chat-names.js';
import type { PanelEnv } from './context.js';
import { errorBody, PANEL_MESSAGES } from './errors.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { handlePanelError } from './middleware/error-handler.js';
import { createRateLimit } from './middleware/rate-limit.js';
import { requestLog } from './middleware/request-log.js';
import { securityHeaders } from './middleware/security-headers.js';
import { createHandlerTimeout } from './middleware/timeout.js';
import { registerAuditRoute } from './routes/audit.js';
import { registerChatSettingsRoute } from './routes/chat-settings.js';
import { registerChatRoutes } from './routes/chats.js';
import { registerGlobalRoutes } from './routes/global.js';
import { registerHealthRoute } from './routes/health.js';
import { registerMeRoute } from './routes/me.js';
import { registerSettingsPreviewRoute } from './routes/settings-preview.js';
import type { ConversationRouteDeps } from './routes/conversation-deps.js';
import { registerConversationExportRoute } from './routes/conversation-export.js';
import { registerConversationLinksRoute } from './routes/conversation-links.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerExclusionRoutes } from './routes/exclusions.js';
import { registerModelViewRoute } from './routes/model-view.js';
import { registerReplyRoute } from './routes/replies.js';
import { registerStaticRoutes } from './static.js';

export interface PanelAppOptions {
    botToken: string;
    /** getChatMember; production passes the panel's own Api, tests a fake */
    membershipLookup: MembershipLookup;
    /** Directory of the built front end */
    staticRoot: string;
    startedAt: Date;
    /** Short commit hash; null when unknown */
    version: string | null;
    /** Clock in ms (default Date.now) */
    now?: () => number;
    /** Requests per user per window (default 60 per 60s) */
    rateLimit?: { limit: number; windowMs: number };
    /** Ceiling of one API handler (default 30s) */
    handlerTimeoutMs?: number;
    /**
     * getChat on the panel's own Api (conversation links refresh a stale
     * username with it); tests pass a fake. Absent: the stored username only.
     */
    chatLookup?: ChatNameLookup;
    /**
     * The panel's own Api. The model view hands it to the tool constructors,
     * which never call it there; default: a client for botToken (no I/O).
     */
    toolApi?: Api;
}

const BODY_LIMIT_BYTES = 32 * 1024;
const DEFAULT_RATE_LIMIT = { limit: 60, windowMs: 60_000 };
const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;
const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

const isApiPath = (path: string): boolean => path === '/api' || path.startsWith('/api/');

const apiNotFound = (context: Context<PanelEnv>): Response =>
    context.json(errorBody('not_found', PANEL_MESSAGES.notFound), 404);

export const createPanelApp = (options: PanelAppOptions): Hono<PanelEnv> => {
    const now = options.now ?? Date.now;
    const checker = createMembershipChecker({ lookup: options.membershipLookup, now });
    const rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
    const app = new Hono<PanelEnv>();

    app.onError(handlePanelError);
    app.use('*', requestLog);
    app.use('*', securityHeaders);

    registerHealthRoute(app, { startedAt: options.startedAt, version: options.version });

    app.use(
        '/api/*',
        bodyLimit({
            maxSize: BODY_LIMIT_BYTES,
            onError: (context) => context.json(errorBody('too_large', PANEL_MESSAGES.tooLarge), 413),
        })
    );
    app.use('/api/*', createAuthMiddleware({ botToken: options.botToken, checker, now }));
    app.use('/api/*', createRateLimit({ ...rateLimit, now }));
    app.use('/api/*', createHandlerTimeout(options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS));

    registerMeRoute(app);
    registerChatRoutes(app);
    registerChatSettingsRoute(app);
    registerSettingsPreviewRoute(app);
    registerGlobalRoutes(app);
    registerAuditRoute(app);

    // Conversations (phase 2)
    const conversationDeps: ConversationRouteDeps = {
        toolApi: options.toolApi ?? new Api(options.botToken),
        chatLookup: options.chatLookup ?? null,
        now,
    };
    registerConversationRoutes(app, conversationDeps);
    registerModelViewRoute(app, conversationDeps);
    registerConversationExportRoute(app, conversationDeps);
    registerConversationLinksRoute(app, conversationDeps);
    registerReplyRoute(app);
    registerExclusionRoutes(app);

    // Method-bound rather than app.all, so the request log can tell it from middleware
    app.on(HTTP_METHODS, '/api/*', apiNotFound);

    registerStaticRoutes(app, options.staticRoot);
    // Methods outside HTTP_METHODS reach nothing above
    app.notFound((context) =>
        isApiPath(context.req.path) ? apiNotFound(context) : context.text('Method Not Allowed', 405)
    );
    return app;
};
