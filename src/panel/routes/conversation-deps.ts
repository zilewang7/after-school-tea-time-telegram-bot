/**
 * What the conversation routes need from outside the request: the panel's own
 * Api (only handed to tool constructors by the model view, never called
 * there), getChat for the links endpoint's username refresh, and the clock.
 * Injected so offline cases can drive the routes without a network.
 */
import type { Api } from 'grammy';
import type { Context } from 'hono';
import type { ChatNameLookup } from '../chat-names.js';
import type { PanelEnv } from '../context.js';
import { PanelError } from '../errors.js';

export interface ConversationRouteDeps {
    toolApi: Api;
    /** getChat; null when the app was built without one (links then trust the stored username) */
    chatLookup: ChatNameLookup | null;
    /** Clock in ms */
    now: () => number;
}

/**
 * A JSON response, refused with 413 when the serialized body is over
 * `maxBytes` (model view 2 MB). Sizes are UTF-8 bytes.
 */
export const jsonWithinLimit = (
    context: Context<PanelEnv>,
    body: unknown,
    maxBytes: number,
    tooLargeMessage: string
): Response => {
    const text = JSON.stringify(body);
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new PanelError('too_large', tooLargeMessage);
    return context.body(text, 200, { 'Content-Type': 'application/json; charset=utf-8' });
};
