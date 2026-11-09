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
 * single switch; groups get the Mini App link fallback instead of the native
 * widget, which is why the share and renderer switches are reported too.
 */
import { GrammyError } from 'grammy';
import { getToolConfig } from '../config/tool-config.js';
import { WIDGET_GUIDE_VERSION } from '../ai/widget/guides/index.js';
import { isWidgetRenderConfigured, widgetRenderHealth } from '../widget-image/index.js';
import { probeWidgetApiRoot, probeWidgetChat, sendWidgetViaApi } from './widget-api.js';
import { isErr } from '../shared/result.js';

/** The renderer sidecar's answer; never throws, never blocks a send */
export interface WidgetRendererReadiness {
    readonly configured: boolean;
    readonly ok: boolean;
    readonly detail: string;
}

export const readWidgetRendererReadiness = async (): Promise<WidgetRendererReadiness> => {
    if (!isWidgetRenderConfigured()) {
        return { configured: false, ok: false, detail: 'WIDGET_RENDER_URL is not set' };
    }
    const health = await widgetRenderHealth();
    return { configured: true, ok: health.ok, detail: health.detail };
};

export interface WidgetReadiness {
    readonly enabled: boolean;
    readonly apiRoot: string;
    readonly cloud: { readonly available: boolean; readonly detail: string };
    readonly local: { readonly available: boolean; readonly detail: string } | null;
    readonly renderer: WidgetRendererReadiness;
    readonly groupChats: 'unknown';
}

const localRoot = (): string | null => {
    const value = process.env.TG_LOCAL_API_ROOT?.trim();
    return value ? value : null;
};

/** Probe both Bot API roots and the renderer; never throws and never sends anything */
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
        renderer: await readWidgetRendererReadiness(),
        // There is no read-only way to see the chat-type gate; /widget_probe answers it
        groupChats: 'unknown',
    };
};

/** The group chats the widget tools may be offered to, per the env whitelist */
const groupWidgetChats = (): number[] => {
    const config = getToolConfig();
    const chats = config.widgetChatIds.size > 0 ? config.widgetChatIds : config.toolChatIds;
    return [...chats].filter((chatId) => chatId < 0).sort((left, right) => left - right);
};

const rendererStatusOf = (renderer: WidgetRendererReadiness): string => {
    if (!renderer.configured) return 'off';
    return renderer.ok ? 'yes' : 'no';
};

/**
 * Startup probe for the card renderer. The `[widget] ready` line already says
 * whether it is usable; this call is what turns a failure into a visible
 * warning with the reason. A missing renderer only costs the card image and
 * the share preview, never a startup error.
 */
export const logWidgetRendererReadiness = async (): Promise<void> => {
    try {
        const renderer = await readWidgetRendererReadiness();
        if (!renderer.ok) {
            console.warn(`[widget] renderer unavailable: ${renderer.detail}`);
        }
    } catch (error) {
        console.warn('[widget] renderer probe failed:', error);
    }
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
                `renderer=${rendererStatusOf(readiness.renderer)} root=${readiness.apiRoot}`
        );
        if (!readiness.renderer.ok) {
            console.log(`[widget] renderer detail: ${readiness.renderer.detail}`);
        }
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
    const renderer = readiness.renderer;
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
        `group widget chats: ${groupWidgetChats().join(',') || '(none)'}`,
        `renderer=${rendererStatusOf(renderer)} (${renderer.detail})`,
        `groupFallback=${config.widgetGroupFallback ? 'on' : 'off'}`,
        `share=${config.shareEnabled ? 'on' : 'off'}`,
        `guide version=${WIDGET_GUIDE_VERSION}`,
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
