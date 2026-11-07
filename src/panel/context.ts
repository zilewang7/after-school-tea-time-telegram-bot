/**
 * The hono environment of the panel app and the per-request auth record the
 * auth middleware leaves on the context.
 */
import type { Context } from 'hono';
import type { ChatAccessResolver } from './access/chat-access.js';
import { PANEL_MESSAGES, PanelError } from './errors.js';
import type { PanelUser } from './types.js';

export interface RequestAuth {
    user: PanelUser;
    /** Memoizes access per chat for this request only */
    access: ChatAccessResolver;
    /** The signed start_param, unparsed; null when absent */
    startParam: string | null;
}

export interface PanelEnv {
    Variables: {
        /** Set by the auth middleware on every /api route except /api/health */
        auth: RequestAuth | undefined;
    };
}

export type PanelContext = Context<PanelEnv>;

/** The request's auth record; a route reached without one is a wiring bug */
export const requireAuth = (context: PanelContext): RequestAuth => {
    const auth = context.get('auth');
    if (auth === undefined) throw new PanelError('unauthorized', PANEL_MESSAGES.unauthorized);
    return auth;
};

export const requireOwner = (auth: RequestAuth): void => {
    if (!auth.user.isOwner) throw new PanelError('forbidden', PANEL_MESSAGES.ownerOnly);
};
