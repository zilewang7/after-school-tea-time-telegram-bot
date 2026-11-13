/**
 * The Bot API client for chat HTML widgets (Telegram 13.2 HTMLBubbles).
 *
 * Widget methods (sendWidget / editMessageWidgetData / …) are Bot API 10.4 and
 * the production bot's grammY client is pinned to the local Bot API server
 * (10.2/10.3, which answers 404 for them). So widgets get their own client:
 * the cloud API through the SOCKS proxy, or the self-hosted server once it is
 * upgraded — only WIDGET_API_ROOT changes.
 *
 * The methods are typed onto grammY's raw Api instead of `as` casts: a raw
 * method call goes to `{apiRoot}/bot<token>/<method>` exactly like every stock
 * method. No grammY upgrade is needed.
 */
import { Api, GrammyError, type ApiClientOptions, type RawApi } from 'grammy';
import type { InlineKeyboardMarkup, Message, MessageEntity } from 'grammy/types';
import { autoRetry } from '@grammyjs/auto-retry';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { requireBotToken } from '../config/bot-token.js';
import { getToolConfig } from '../config/tool-config.js';
import { to, type Result } from '../shared/result.js';

/** A widget request's payload as Bot API 10.4 takes it */
export interface SendWidgetArgs {
    /** Optional in the type because the readiness probe sends an invalid payload
     * on purpose (missing chat_id); a real send always sets it. */
    readonly chat_id?: number;
    readonly html: string;
    readonly width?: number;
    readonly height?: number;
    readonly caption?: string;
    readonly caption_entities?: MessageEntity[];
    readonly allow_queries?: boolean;
    readonly is_shared?: boolean;
    readonly chat_data?: string;
    readonly public_data?: string;
    readonly reply_parameters?: { readonly message_id: number };
    readonly reply_markup?: InlineKeyboardMarkup;
}

export interface EditWidgetDataArgs {
    readonly chat_id: number;
    readonly message_id: number;
    readonly chat_data?: string;
    readonly public_data?: string;
}

/** The two widget methods this bot uses, typed onto the stock RawApi */
interface WidgetRawApi extends RawApi {
    readonly sendWidget: (
        args: SendWidgetArgs,
        signal?: AbortSignal
    ) => Promise<Message>;
    readonly editMessageWidgetData: (
        args: EditWidgetDataArgs,
        signal?: AbortSignal
    ) => Promise<Message | true>;
}


const buildCloudClient = (apiRoot: string): Api<WidgetRawApi> => {
    const proxyUrl = process.env.BOT_PROXY;
    // Only the cloud API is reached through the SOCKS proxy: the local Bot API
    // is an http URL on the docker network, and a socks5h request for that
    // hostname through WARP hangs until the fetch timeout.
    const useProxy = proxyUrl !== undefined && apiRoot.startsWith('https://');
    const client: ApiClientOptions = useProxy
        ? {
              apiRoot,
              baseFetchConfig: { agent: new SocksProxyAgent(proxyUrl), compress: true },
          }
        : { apiRoot };
    const api = new Api<WidgetRawApi>(requireBotToken(), client);
    // Same flood-wait safety net as the main client; widget sends are rare, but
    // a burst of edits after a scheduled state refresh must not throw.
    api.config.use(autoRetry({ maxRetryAttempts: 2, maxDelaySeconds: 30 }));
    return api;
};

const REQUEST_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 10_000;

/** grammY's raw method signal type clashes with the global AbortSignal; race instead */
const withTimeout = async <T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string
): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
            timeoutMs
        );
        timer.unref();
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
};

let widgetApi: Api<WidgetRawApi> | undefined;
let widgetApiRoot: string | undefined;

/** The widget client; a config change of WIDGET_API_ROOT is picked up on restart */
export const getWidgetApi = (): Api<WidgetRawApi> => {
    const root = getToolConfig().widgetApiRoot;
    if (widgetApi === undefined || widgetApiRoot !== root) {
        widgetApi = buildCloudClient(root);
        widgetApiRoot = root;
    }
    return widgetApi;
};

const messageIdOf = (message: Message | true): number | undefined =>
    typeof message === 'object' ? message.message_id : undefined;

/** Send one widget message; the caller owns the session and the version data */
export const sendWidgetViaApi = async (args: SendWidgetArgs): Promise<Result<number>> => {
    const [error, sent] = await to(
        withTimeout(getWidgetApi().raw.sendWidget(args), REQUEST_TIMEOUT_MS, 'sendWidget')
    );
    if (error !== null) return [error, undefined];
    const messageId = messageIdOf(sent);
    return messageId === undefined
        ? [new Error('sendWidget returned no message id'), undefined]
        : [null, messageId];
};

/**
 * Update the bot-owned state of a widget message. The client re-renders from
 * `chat_data`/`public_data` without the message being edited; both are ≤1024 B.
 */
export const editWidgetDataViaApi = async (
    args: EditWidgetDataArgs
): Promise<Result<true>> => {
    const [error] = await to(
        withTimeout(
            getWidgetApi().raw.editMessageWidgetData(args),
            REQUEST_TIMEOUT_MS,
            'editMessageWidgetData'
        )
    );
    return error !== null ? [error, undefined] : [null, true];
};

/**
 * Buttons on a widget message can only be edited through the same client that
 * sent it: the local Bot API server cannot parse widget media in a Message.
 */
export const editWidgetReplyMarkup = async (
    chatId: number,
    messageId: number,
    replyMarkup: InlineKeyboardMarkup
): Promise<Result<true>> => {
    const [error] = await to(
        withTimeout(
            getWidgetApi().raw.editMessageReplyMarkup({
                chat_id: chatId,
                message_id: messageId,
                reply_markup: replyMarkup,
            }),
            REQUEST_TIMEOUT_MS,
            'editMessageReplyMarkup'
        )
    );
    return error !== null ? [error, undefined] : [null, true];
};

/** A disposable widget for probes: valid, tiny, caption-free */
export const PROBE_WIDGET_HTML =
    '<meta charset="utf-8"><div style="font:14px system-ui;padding:8px 10px">widget probe</div>';

/**
 * Does a Bot API root know the widget methods? A missing method is a 404; a
 * present one rejects the empty payload with a parameter error. Only the
 * answer is used — no message is sent.
 */
export const probeWidgetApiRoot = async (
    apiRoot: string
): Promise<{ readonly available: boolean; readonly detail: string }> => {
    try {
        const api = buildCloudClient(apiRoot);
        // Intentionally invalid: chat_id is missing, so nothing is sent
        await withTimeout(
            api.raw.sendWidget({ html: PROBE_WIDGET_HTML }),
            PROBE_TIMEOUT_MS,
            'sendWidget probe'
        );
        // A real success would mean the probe sent something; treat it as available
        return { available: true, detail: 'method answered' };
    } catch (error) {
        if (error instanceof GrammyError) {
            if (error.error_code === 404) return { available: false, detail: 'method not found (404)' };
            const description = error.description;
            if (/parameter .*html/i.test(description) || /chat not found/i.test(description)) {
                return { available: true, detail: description };
            }
            return { available: true, detail: `method answered: ${description}` };
        }
        const message = error instanceof Error ? error.message : String(error);
        return { available: false, detail: `probe failed: ${message}` };
    }
};

/** Send a throwaway probe widget into one chat and delete it right away */
export const probeWidgetChat = async (
    chatId: number
): Promise<{ readonly ok: boolean; readonly detail: string }> => {
    const [sendError, messageId] = await sendWidgetViaApi({
        chat_id: chatId,
        html: PROBE_WIDGET_HTML,
        width: 0,
        height: 0,
    });
    if (sendError !== null) {
        const description =
            sendError instanceof GrammyError ? sendError.description : sendError.message;
        return { ok: false, detail: description };
    }
    const [deleteError] = await to(
        withTimeout(
            getWidgetApi().raw.deleteMessage({ chat_id: chatId, message_id: messageId }),
            REQUEST_TIMEOUT_MS,
            'deleteMessage'
        )
    );
    if (deleteError !== null) {
        return {
            ok: true,
            detail: `sent message ${messageId} (delete failed: ${String(deleteError)})`,
        };
    }
    return { ok: true, detail: `sent and deleted message ${messageId}` };
};
