/**
 * Start and stop the panel's HTTP server inside the bot process.
 *
 * Off unless WEBAPP_PORT is set, so offline scripts and deployments without
 * it are untouched. Listens on 0.0.0.0 (only Traefik reaches it; no host port
 * is published). The server's 'error' event is handled here: otherwise an
 * EADDRINUSE would end up in the process-wide uncaughtException guard and
 * vanish. A failed listen leaves the bot running without a panel.
 */
import { Server as HttpServer } from 'node:http';
import { serve, type ServerType } from '@hono/node-server';
import { Api, type ApiClientOptions } from 'grammy';
import { botApiMembershipLookup } from './access/membership.js';
import { createPanelApp } from './app.js';
import { setPanelRunning } from './panel-state.js';
import { DEFAULT_STATIC_ROOT } from './static.js';
import { readCodeVersion } from './version.js';

export interface StartPanelOptions {
    /**
     * The bot's own Api (autoRetry attached), for the panel's sends (group
     * notifications, phase 4; unused before). Membership lookups never use it.
     */
    api: Api;
    /** The bot's client config (apiRoot / proxy), reused by the lookup Api */
    clientConfig?: ApiClientOptions;
}

const LISTEN_HOST = '0.0.0.0';
const STOP_TIMEOUT_MS = 3000;
const MAX_PORT = 65535;

let activeServer: ServerType | null = null;

/** undefined = unset; null = set but not a usable port */
const parsePort = (raw: string | undefined): number | null | undefined => {
    const trimmed = raw?.trim() ?? '';
    if (trimmed === '') return undefined;
    if (!/^\d{1,5}$/.test(trimmed)) return null;
    const port = Number(trimmed);
    return port >= 1 && port <= MAX_PORT ? port : null;
};

const listen = (fetch: (request: Request) => Response | Promise<Response>, port: number): Promise<ServerType | null> =>
    new Promise((resolve) => {
        let listening = false;
        const server = serve(
            // Keep the process-wide Request / Response untouched: the bot shares them
            { fetch, port, hostname: LISTEN_HOST, overrideGlobalObjects: false },
            () => {
                listening = true;
                console.log(`[panel] listening on :${port}`);
                resolve(server);
            }
        );
        server.on('error', (error: unknown) => {
            if (!listening) {
                console.error('[panel] failed to listen:', error);
                resolve(null);
                return;
            }
            console.error('[panel] server error:', error);
        });
    });

/**
 * Start the server; resolves once it listens (or has failed to). Call after
 * the settings cache and the MCP tools are ready, before bot.start.
 */
export const startPanel = async (options: StartPanelOptions): Promise<void> => {
    const port = parsePort(process.env.WEBAPP_PORT);
    if (port === undefined) {
        console.log('[panel] disabled (WEBAPP_PORT unset)');
        return;
    }
    if (port === null) {
        console.error('[panel] disabled (WEBAPP_PORT is not a valid port)');
        return;
    }
    if (activeServer !== null) return;

    // No autoRetry here: a 429 must surface as "unavailable", not be slept on
    const membershipApi = new Api(process.env.BOT_TOKEN, options.clientConfig);
    const app = createPanelApp({
        botToken: process.env.BOT_TOKEN,
        membershipLookup: botApiMembershipLookup(membershipApi),
        staticRoot: DEFAULT_STATIC_ROOT,
        startedAt: new Date(),
        version: await readCodeVersion(),
    });
    activeServer = await listen(app.fetch, port);
    setPanelRunning(activeServer !== null);
};

/** Close the server and drop open connections, waiting at most 3s */
export const stopPanel = async (): Promise<void> => {
    const server = activeServer;
    if (server === null) return;
    activeServer = null;
    setPanelRunning(false);

    let timer: NodeJS.Timeout | undefined;
    const closed = new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Keep-alive sockets would hold close() open until they idle out
        if (server instanceof HttpServer) server.closeAllConnections();
    });
    const timedOut = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STOP_TIMEOUT_MS);
    });
    await Promise.race([closed, timedOut]);
    clearTimeout(timer);
    console.log('[panel] stopped');
};
