/**
 * Widget readiness: is the Bot API on the other side able to send widgets yet?
 *
 * Phase 0 ships the whole path switched off. The trigger is a config flip, not
 * a code change, so this module keeps the "can we flip it?" answer one command
 * away: the startup probe checks the configured roots for the Bot API 10.4
 * methods (a missing method is 404; a present one rejects an empty payload), and
 * /widget_probe sends a throwaway widget into one chat to test the server-side
 * chat-type gate that no read-only call can see.
 *
 * Nothing here enables anything: it only reports. `WIDGET_ENABLE` stays the
 * single switch, and group chats are expected to stay closed until Telegram
 * says otherwise.
 */
import { GrammyError } from 'grammy';
import { getToolConfig } from '../config/tool-config.js';
import { probeWidgetApiRoot, probeWidgetChat, sendWidgetViaApi } from './widget-api.js';
import { isErr } from '../shared/result.js';

export interface WidgetReadiness {
    readonly enabled: boolean;
    readonly apiRoot: string;
    readonly cloud: { readonly available: boolean; readonly detail: string };
    readonly local: { readonly available: boolean; readonly detail: string } | null;
    readonly groupChats: 'unknown';
}

const localRoot = (): string | null => {
    const value = process.env.TG_LOCAL_API_ROOT?.trim();
    return value ? value : null;
};

/** Probe both roots; never throws and never sends anything */
export const readWidgetReadiness = async (): Promise<WidgetReadiness> => {
    const config = getToolConfig();
    const cloud = await probeWidgetApiRoot(config.widgetApiRoot);
    const local = localRoot();
    const localProbe =
        local === null || local === config.widgetApiRoot
            ? null
            : await probeWidgetApiRoot(local);
    return {
        enabled: config.widgetEnabled,
        apiRoot: config.widgetApiRoot,
        cloud,
        local: localProbe,
        // There is no read-only way to see the chat-type gate; /widget_probe answers it
        groupChats: 'unknown',
    };
};

/** One log line at startup: what the trigger would find today */
export const logWidgetReadiness = async (): Promise<void> => {
    const config = getToolConfig();
    if (!config.widgetReadyCheck) return;
    try {
        const readiness = await readWidgetReadiness();
        console.log(
            `[widget] ready cloud=${readiness.cloud.available ? 'yes' : 'no'} ` +
                `local=${readiness.local === null ? 'n/a' : readiness.local.available ? 'yes' : 'no'} ` +
                `groups=${readiness.groupChats} enabled=${readiness.enabled ? 'yes' : 'no'} ` +
                `root=${readiness.apiRoot}`
        );
        if (!readiness.cloud.available) {
            console.log(`[widget] cloud probe detail: ${readiness.cloud.detail}`);
        }
        if (readiness.local !== null && !readiness.local.available) {
            console.log(`[widget] local probe detail: ${readiness.local.detail}`);
        }
    } catch (error) {
        // A probe failure must never affect startup
        console.warn('[widget] readiness probe failed:', error);
    }
};

/** Human-readable status for the owner command; each line is one fact */
export const formatWidgetStatus = async (): Promise<string> => {
    const config = getToolConfig();
    const local = localRoot();
    const readiness = await readWidgetReadiness();
    const lines = [
        `WIDGET_ENABLE=${config.widgetEnabled ? '1' : '0'}`,
        `WIDGET_API_ROOT=${config.widgetApiRoot}`,
        `cloud methods: ${readiness.cloud.available ? 'available' : 'NOT available'} (${readiness.cloud.detail})`,
        `local root: ${local ?? 'unset'}`,
        `local methods: ${
            readiness.local === null
                ? 'n/a'
                : readiness.local.available
                  ? 'available'
                  : 'NOT available'
        }`,
        `group chat send: unknown (use /widget_probe <chat_id>)`,
        `WIDGET_ALLOW_HTML=${config.widgetAllowHtml ? '1' : '0'}`,
        `limits: html<=${config.widgetMaxHtmlBytes} zlib<=${config.widgetMaxGzipBytes}`,
        `WIDGET_CHAT_IDS=${[...config.widgetChatIds].join(',') || '(follow TOOL_CHAT_IDS)'}`,
        `guide version=${config.widgetGuideVersion}`,
    ];
    return lines.join('\n');
};

/** Owner probe: send a throwaway widget into one chat and delete it */
export const runWidgetChatProbe = async (chatId: number): Promise<string> => {
    const result = await probeWidgetChat(chatId);
    return result.ok
        ? `widget probe OK: ${result.detail}`
        : `widget probe FAILED: ${result.detail}`;
};

/** Kept for tests: one tiny send without the probe wrapper */
export const sendProbeWidget = async (chatId: number): Promise<string> => {
    const result = await sendWidgetViaApi({ chat_id: chatId, html: '<b>probe</b>' });
    if (isErr(result)) {
        const description =
            result[0] instanceof GrammyError ? result[0].description : String(result[0]);
        return `sendWidget failed: ${description}`;
    }
    return `sendWidget OK: message ${result[1]}`;
};
