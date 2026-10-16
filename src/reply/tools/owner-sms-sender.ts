/**
 * Texts the owner's phone through the owner SMS MCP server (cmcc): its
 * `send_text` tool with `{ content }` only, never `to` — the server's default
 * recipient is the owner. A send is never retried here, since it may already
 * have gone out: the model gets the outcome and decides.
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
import { createOwnerSmsConnections } from './owner-sms-connection.js';
import { startOwnerSmsSendAbort, type OwnerSmsSendAbort } from './owner-sms-deadline.js';

/** One whole send, connecting included; the reply's stop signal applies too */
export const OWNER_SMS_TIMEOUT_MS = 15_000;

/** Names the connection in the MCP client and its logs */
const SERVER_NAME = 'owner-sms';
const SEND_TEXT_TOOL = 'send_text';

/**
 * How a send ended. `sendStarted`: send_text was already on its way, so the
 * text may have gone out.
 */
export type OwnerSmsOutcome =
    /** The server took the text; `serverText` is what it answered, empty when it said nothing */
    | { readonly kind: 'sent'; readonly serverText: string }
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
            // No tool-level answer: the connection is suspect, the next send reconnects
            connections.discard(connection);
            return interruption(true) ?? callFailure(error);
        }
    };

    const send = async (text: string, signal: AbortSignal): Promise<OwnerSmsOutcome> => {
        const sendAbort = startOwnerSmsSendAbort(signal, timeoutMs);
        try {
            return await sendText(text, signal, sendAbort);
        } finally {
            sendAbort.release();
        }
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
