/**
 * Texts the owner's phone through the owner SMS MCP server (cmcc): its
 * `send_text` tool with `{ content }` only, never `to` — the server's default
 * recipient is the owner.
 *
 * A send is retried once, but only when the first attempt provably did not
 * deliver. A connection that never came up, or an HTTP refusal, is retried at
 * once: nothing was sent. An answer that never came (timeout, transport
 * failure) is first looked up in the server's own sent log, and retried only
 * when the text is not in it. That lookup is what keeps a retry from
 * double-texting the owner. A tool-level error is the server's answer and the
 * stop signal is the user's, so neither is retried.
 */
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
    callConnectedMcpTool,
    connectMcpServer,
    type McpServerConfig,
    type McpServerConnection,
} from '../../ai/mcp/index.js';
import { getToolConfig } from '../../config/tool-config.js';
import { getErrorMessage } from '../../shared/errors.js';
import { isJsonObject } from '../../shared/json-object.js';
import { createOwnerSmsConnections } from './owner-sms-connection.js';
import { startOwnerSmsSendAbort, type OwnerSmsSendAbort } from './owner-sms-deadline.js';

/** One attempt, connecting included; the reply's stop signal applies too */
export const OWNER_SMS_TIMEOUT_MS = 15_000;

/** Reading the sent log is cheaper than a send, so it gets a tighter budget */
const SENT_LOG_TIMEOUT_MS = 8_000;
/** The server buffers 200 sends, newest first; ours is always among the newest */
const SENT_LOG_LIMIT = 20;

/** Names the connection in the MCP client and its logs */
const SERVER_NAME = 'owner-sms';
const SEND_TEXT_TOOL = 'send_text';
const SENT_LOG_TOOL = 'list_sent_messages';

/**
 * How a send ended. `sendStarted`: send_text was already on its way, so the
 * text may have gone out.
 */
export type OwnerSmsOutcome =
    /**
     * The server took the text; `serverText` is what it answered, empty when it
     * said nothing. `verified`: the send was confirmed in the sent log after an
     * attempt that got no answer.
     */
    | { readonly kind: 'sent'; readonly serverText: string; readonly verified?: true }
    /** The server answered with a tool error; `serverText` as above */
    | { readonly kind: 'rejected'; readonly serverText: string }
    /** No connection came up (network, auth, handshake): nothing was sent */
    | { readonly kind: 'connect-failed'; readonly reason: string }
    /** The server turned send_text away with HTTP 4xx (e.g. a revoked token): nothing was sent */
    | { readonly kind: 'http-refused'; readonly reason: string }
    /** send_text failed below the tool level (network, HTTP 5xx, JSON-RPC error): it may have gone out */
    | { readonly kind: 'failed'; readonly reason: string }
    | { readonly kind: 'timeout'; readonly sendStarted: boolean }
    /** The reply was stopped */
    | { readonly kind: 'stopped'; readonly sendStarted: boolean };

export interface OwnerSmsEndpoint {
    readonly url: string;
    /** Bearer token; empty = no Authorization header */
    readonly token: string;
}

export interface OwnerSmsSender {
    readonly send: (text: string, signal: AbortSignal) => Promise<OwnerSmsOutcome>;
}

const toServerConfig = ({ url, token }: OwnerSmsEndpoint): McpServerConfig => ({
    serverUrl: url,
    ...(token === '' ? {} : { headers: { Authorization: `Bearer ${token}` } }),
});

/** HTTP 4xx: the server turned the request away without acting on it */
const isHttpRefusal = (error: unknown): boolean =>
    error instanceof StreamableHTTPError &&
    typeof error.code === 'number' &&
    error.code >= 400 &&
    error.code < 500;

/** send_text threw without being stopped or timed out */
const callFailure = (error: unknown): OwnerSmsOutcome => {
    const reason = getErrorMessage(error);
    return isHttpRefusal(error) ? { kind: 'http-refused', reason } : { kind: 'failed', reason };
};

/** Nothing reached the tool, so a second attempt cannot duplicate anything */
const isProvablyNotSent = (outcome: OwnerSmsOutcome): boolean =>
    outcome.kind === 'connect-failed' ||
    outcome.kind === 'http-refused' ||
    (outcome.kind === 'timeout' && !outcome.sendStarted);

/** The tool may have run; only the server's sent log can tell */
const isUnclear = (outcome: OwnerSmsOutcome): boolean =>
    outcome.kind === 'failed' || (outcome.kind === 'timeout' && outcome.sendStarted);

/**
 * Does the server's sent log list this exact text? A failed entry (`ok: false`)
 * is a send that did not happen, so it does not count. null = the log could not
 * be read, which leaves the outcome unknown.
 */
const sentLogHasText = (raw: string, text: string): boolean | null => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!isJsonObject(parsed) || !Array.isArray(parsed.sent)) return null;
    return parsed.sent.some(
        (entry) => isJsonObject(entry) && entry.content === text && entry.ok !== false
    );
};

/** Connects on the first send and reuses the connection; `timeoutMs` is only shortened by tests */
export const createOwnerSmsSender = (
    endpoint: OwnerSmsEndpoint,
    timeoutMs: number = OWNER_SMS_TIMEOUT_MS
): OwnerSmsSender => {
    const connections = createOwnerSmsConnections(() =>
        connectMcpServer(SERVER_NAME, toServerConfig(endpoint))
    );

    const sendText = async (
        text: string,
        stop: AbortSignal,
        sendAbort: OwnerSmsSendAbort
    ): Promise<OwnerSmsOutcome> => {
        // Stopped or out of time; null = the server or the network failed
        const interruption = (sendStarted: boolean): OwnerSmsOutcome | null => {
            if (stop.aborted) return { kind: 'stopped', sendStarted };
            if (sendAbort.timedOut()) return { kind: 'timeout', sendStarted };
            return null;
        };

        let connection: McpServerConnection;
        try {
            connection = await connections.take(sendAbort.signal);
        } catch (error) {
            return interruption(false) ?? { kind: 'connect-failed', reason: getErrorMessage(error) };
        }

        try {
            const result = await callConnectedMcpTool(
                connection.client,
                SEND_TEXT_TOOL,
                { content: text },
                { signal: sendAbort.signal }
            );
            connections.keep(connection);
            // Not the client's placeholder for an empty answer: that is no server text
            const serverText = result.hasContent ? result.content : '';
            return result.isError ? { kind: 'rejected', serverText } : { kind: 'sent', serverText };
        } catch (error) {
            // No tool-level answer: the connection is suspect, the next attempt reconnects
            connections.discard(connection);
            return interruption(true) ?? callFailure(error);
        }
    };

    /** One attempt under its own deadline; a retry gets a fresh one */
    const attempt = async (text: string, stop: AbortSignal): Promise<OwnerSmsOutcome> => {
        const sendAbort = startOwnerSmsSendAbort(stop, timeoutMs);
        try {
            return await sendText(text, stop, sendAbort);
        } finally {
            sendAbort.release();
        }
    };

    /** Whether an attempt that got no answer already delivered `text`; null = cannot tell */
    const sentLogSaysDelivered = async (
        text: string,
        stop: AbortSignal
    ): Promise<boolean | null> => {
        const lookupAbort = startOwnerSmsSendAbort(stop, SENT_LOG_TIMEOUT_MS);
        try {
            let connection: McpServerConnection;
            try {
                connection = await connections.take(lookupAbort.signal);
            } catch {
                return null;
            }
            try {
                const result = await callConnectedMcpTool(
                    connection.client,
                    SENT_LOG_TOOL,
                    { limit: SENT_LOG_LIMIT },
                    { signal: lookupAbort.signal }
                );
                connections.keep(connection);
                return result.isError ? null : sentLogHasText(result.content, text);
            } catch {
                connections.discard(connection);
                return null;
            }
        } finally {
            lookupAbort.release();
        }
    };

    const send = async (text: string, signal: AbortSignal): Promise<OwnerSmsOutcome> => {
        const first = await attempt(text, signal);
        if (!isProvablyNotSent(first) && !isUnclear(first)) return first;
        // The user stopped the reply: no second attempt behind their back
        if (signal.aborted) return first;

        if (isProvablyNotSent(first)) {
            console.log('[sms] the first attempt never reached the server; retrying once');
            return attempt(text, signal);
        }

        console.log('[sms] the first attempt got no answer; checking the sent log');
        const delivered = await sentLogSaysDelivered(text, signal);
        if (delivered === true) {
            console.log('[sms] the text is in the sent log; it was delivered after all');
            return { kind: 'sent', serverText: '', verified: true };
        }
        if (delivered === null) {
            console.log('[sms] the sent log could not be read; the outcome stays unknown');
            return first;
        }
        console.log('[sms] the text is not in the sent log; retrying once');
        return attempt(text, signal);
    };

    return { send };
};

let defaultSender: OwnerSmsSender | undefined;

/**
 * The sender for OWNER_SMS_MCP_URL, created on the first send. The token is
 * read from the env then, once, and goes nowhere but the Authorization header.
 */
export const getOwnerSmsSender = (): OwnerSmsSender => {
    defaultSender ??= createOwnerSmsSender({
        url: getToolConfig().ownerSmsUrl,
        token: process.env.OWNER_SMS_MCP_TOKEN?.trim() ?? '',
    });
    return defaultSender;
};
