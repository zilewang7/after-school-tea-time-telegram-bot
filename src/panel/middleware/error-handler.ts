/**
 * Turns anything thrown below a route into the JSON error body. Panel errors
 * carry their own code and status; a rate-limited membership lookup is 503;
 * hono's body limit is 413; everything else is a 500 whose stack is logged.
 * Messages never echo request data.
 */
import type { Context, ErrorHandler } from 'hono';
import { MembershipUnavailableError } from '../access/chat-access.js';
import type { PanelEnv } from '../context.js';
import { errorBody, PANEL_MESSAGES, PanelError } from '../errors.js';
import { routeTemplateOf } from './request-log.js';

/** hono's body-limit error class is not exported; its name is stable */
const BODY_LIMIT_ERROR_NAME = 'BodyLimitError';

const toPanelError = (error: Error): PanelError => {
    if (error instanceof PanelError) return error;
    if (error instanceof MembershipUnavailableError) {
        return new PanelError('internal', PANEL_MESSAGES.membershipUnavailable, { status: 503 });
    }
    if (error.name === BODY_LIMIT_ERROR_NAME) return new PanelError('too_large', PANEL_MESSAGES.tooLarge);
    return new PanelError('internal', PANEL_MESSAGES.internal);
};

/**
 * 5xx get logged: unexpected errors with their stack; our own 503 / 504
 * (rate-limited lookup, handler ceiling) as one line, their stack says nothing.
 */
const logServerError = (error: Error, panelError: PanelError, context: Context<PanelEnv>): void => {
    if (panelError.status < 500) return;
    const route = `${context.req.method} ${routeTemplateOf(context)}`;
    if (error instanceof PanelError) {
        console.warn(`[panel] ${route} ${panelError.status} ${panelError.code}: ${panelError.message}`);
        return;
    }
    console.error(`[panel] ${route} failed:`, error);
};

export const handlePanelError: ErrorHandler<PanelEnv> = (error, context) => {
    const panelError = toPanelError(error);
    logServerError(error, panelError, context);
    if (panelError.retryAfterSeconds !== null) {
        context.header('Retry-After', String(panelError.retryAfterSeconds));
    }
    return context.json(errorBody(panelError.code, panelError.message), panelError.status);
};
