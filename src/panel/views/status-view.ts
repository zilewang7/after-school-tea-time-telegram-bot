/**
 * GET /api/status as the API returns it (design §6.6): process facts (owner
 * only), the replies being generated and the recent reply errors, both
 * filtered to the chats the requester can see. Members see what a live reply
 * answers (author and first 40 characters); observers never do.
 *
 * Units: times are ISO strings, durations milliseconds / seconds as named.
 */
import { listMcpServers } from '../../ai/mcp/client.js';
import { isTestInstance } from '../../config/instance.js';
import type { ChatRow } from '../../db/queries/panel-registry.js';
import { getGlobalDefaultModel, getGlobalDefaultModelSource } from '../../services/chat-settings-service.js';
import { getLastCleanupRun } from '../../services/cleanup-status.js';
import type { BotMessageSession } from '../../services/bot-message-service.js';
import type { RecentReplyError } from '../../services/recent-reply-errors.js';
import type { ErrorKind } from '../../shared/error-kind.js';
import type { TriggerSummary } from '../queries/trigger-messages.js';
import type { VisibleAccess } from '../types.js';

export interface ProcessStatusView {
    /** Always true: an answer means the bot process is up */
    readonly online: true;
    readonly startedAt: string;
    readonly uptimeSeconds: number;
    /** Short commit hash; null = unknown (the test image has no git) */
    readonly version: string | null;
    readonly testInstance: boolean;
    readonly globalDefaultModel: string;
    readonly globalDefaultModelSource: 'panel' | 'env';
    /** Connected MCP servers only; failed ones are only in the startup log */
    readonly mcpServers: readonly { readonly name: string; readonly toolCount: number }[];
    /** The last hourly cleanup of this process; null until the first one */
    readonly lastCleanup: { readonly finishedAt: string; readonly elapsedMs: number; readonly summary: string } | null;
}

export interface StatusChatView {
    readonly chatId: number;
    readonly type: string | null;
    /** Group title or private chat user's name; null until known */
    readonly title: string | null;
    readonly username: string | null;
}

/**
 * - preparing: waiting for media / building the context, no request yet
 * - waiting: the request is out, no text or thinking yet
 * - streaming: the first chunk arrived
 */
export type ReplyPhase = 'preparing' | 'waiting' | 'streaming';

export interface ActiveReplyView {
    readonly chat: StatusChatView;
    readonly access: VisibleAccess;
    readonly firstMessageId: number;
    readonly userMessageId: number;
    readonly model: string;
    readonly platform: string;
    readonly commandType: string;
    readonly isRetry: boolean;
    readonly startedAt: string;
    readonly elapsedMs: number;
    readonly phase: ReplyPhase;
    /** The tool status the reply shows right now, e.g. 「🎨 正在画图…」; null when no tool runs */
    readonly statusLine: string | null;
    /** Members only; always null for observers */
    readonly trigger: TriggerSummary | null;
}

export interface StatusErrorView {
    readonly at: string;
    readonly chat: StatusChatView;
    readonly access: VisibleAccess;
    readonly model: string;
    readonly errorKind: ErrorKind;
    readonly errorSummary: string;
    readonly firstMessageId: number;
}

export interface StatusResponse {
    readonly serverTime: string;
    /** Owner only; null for everyone else */
    readonly process: ProcessStatusView | null;
    /** Longest running first */
    readonly active: readonly ActiveReplyView[];
    /** Newest first, at most 50 (in memory: emptied by a restart) */
    readonly recentErrors: readonly StatusErrorView[];
}

export const buildProcessStatus = (info: { startedAt: Date; version: string | null }, now: Date): ProcessStatusView => {
    const cleanup = getLastCleanupRun();
    return {
        online: true,
        startedAt: info.startedAt.toISOString(),
        uptimeSeconds: Math.max(0, Math.floor((now.getTime() - info.startedAt.getTime()) / 1000)),
        version: info.version,
        testInstance: isTestInstance(),
        globalDefaultModel: getGlobalDefaultModel(),
        globalDefaultModelSource: getGlobalDefaultModelSource(),
        mcpServers: listMcpServers().map((server) => ({ name: server.name, toolCount: server.tools.length })),
        lastCleanup:
            cleanup === null
                ? null
                : { finishedAt: cleanup.finishedAt.toISOString(), elapsedMs: cleanup.elapsedMs, summary: cleanup.summary },
    };
};

export const toStatusChatView = (chatId: number, chat: ChatRow | undefined): StatusChatView => ({
    chatId,
    type: chat?.type ?? null,
    title: chat?.title ?? null,
    username: chat?.username ?? null,
});

const phaseOf = (session: BotMessageSession): ReplyPhase => {
    if (session.metrics.requestStartedAt === null) return 'preparing';
    return session.metrics.firstChunkAt === null ? 'waiting' : 'streaming';
};

export const toActiveReplyView = (input: {
    session: BotMessageSession;
    chat: StatusChatView;
    access: VisibleAccess;
    trigger: TriggerSummary | null;
    now: Date;
}): ActiveReplyView => {
    const { session, access, now } = input;
    return {
        chat: input.chat,
        access,
        firstMessageId: session.firstMessageId,
        userMessageId: session.userMessageId,
        model: session.model,
        platform: session.metrics.platform,
        commandType: session.metrics.commandType,
        isRetry: session.isRetry,
        startedAt: session.metrics.startedAt.toISOString(),
        elapsedMs: Math.max(0, now.getTime() - session.metrics.startedAt.getTime()),
        phase: phaseOf(session),
        statusLine: session.statusLine,
        trigger: access === 'member' ? input.trigger : null,
    };
};

export const toStatusErrorView = (entry: RecentReplyError, chat: StatusChatView, access: VisibleAccess): StatusErrorView => ({
    at: entry.at.toISOString(),
    chat,
    access,
    model: entry.model,
    errorKind: entry.errorKind,
    errorSummary: entry.errorSummary,
    firstMessageId: entry.firstMessageId,
});
