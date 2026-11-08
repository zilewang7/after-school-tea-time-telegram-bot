/**
 * The bot's replies as the panel shows them: the one-version summary on a
 * tree node and the full detail (every version) of GET …/replies/:id. Bot
 * output only, so members and observers see the same — except
 * `triggerUserId`, a per-person column observers never get.
 *
 * Attachments are described by kind and size only: no base64 ever leaves the
 * server, and `modelParts` is reduced to whether there were any.
 */
import { sniffMediaMime } from '../../ai/image-generation/image-mime.js';
import type { AgentStats } from '../../ai/types.js';
import { getMessage, type BotResponse, type ResponseVersion } from '../../db/index.js';
import { findRootMessage, type ContextMessage } from '../../db/queries/context-queries.js';
import { isBotReplyInFlight } from '../../state.js';
import type { VisibleAccess } from '../types.js';
import { base64ByteLength } from './byte-size.js';
import { loadReplyMetrics, type ReplyMetricsView } from './reply-metrics.js';
import {
    buildToolRecordsView,
    parseAgentStats,
    toToolUsageViews,
    type ToolRecordsView,
    type ToolUsageView,
} from './tool-records-view.js';

export interface ReplySummaryView {
    firstMessageId: number;
    versionCount: number;
    /** 1-based; null when no version is stored (still streaming, or no bot_responses row) */
    currentVersion: number | null;
    model: string | null;
    text: string | null;
    thinkingText: string | null;
    toolSummary: ToolUsageView[];
    errorMessage: string | null;
    wasStoppedByUser: boolean;
}

export interface AttachmentView {
    kind: 'image' | 'sticker' | 'file' | 'widget';
    /** Sniffed from the bytes for images, as stored for files; null when unknown */
    mimeType: string | null;
    sizeBytes: number;
}

export interface ReplyVersionView {
    versionId: number;
    createdAt: string;
    model: string | null;
    text: string;
    thinkingText: string | null;
    tools: ToolRecordsView;
    agentStats: AgentStats | null;
    errorMessage: string | null;
    wasStoppedByUser: boolean;
    attachments: AttachmentView[];
    hasModelParts: boolean;
    /** reply_metrics of this version; null for versions without a row */
    metrics: ReplyMetricsView | null;
}

export interface ReplyDetailView {
    firstMessageId: number;
    userMessageId: number;
    /** Root of the conversation the reply belongs to; null when its chain cannot be read */
    rootId: number | null;
    commandType: string | null;
    generating: boolean;
    versionCount: number;
    /** 1-based; null when no version is stored yet */
    currentVersion: number | null;
    versions: ReplyVersionView[];
    /** Author of the message the reply answers; members only, never sent to observers */
    triggerUserId?: number | null;
}

const BASE64_SNIFF_CHARS = 24;

const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** The model of one version; versions stored before it was recorded fall back to metadata.model */
export const modelOfVersion = (version: ResponseVersion, response: BotResponse): string | null => {
    if (typeof version.model === 'string' && version.model !== '') return version.model;
    const metadataModel: unknown = response.getMetadata().model;
    return typeof metadataModel === 'string' && metadataModel !== '' ? metadataModel : null;
};

/** The tree node's summary of the current version; a bot row without bot_responses keeps its text */
export const toReplySummaryView = (response: BotResponse | undefined, message: ContextMessage): ReplySummaryView => {
    if (response === undefined) {
        return {
            firstMessageId: message.messageId,
            versionCount: 0,
            currentVersion: null,
            model: null,
            text: message.text,
            thinkingText: null,
            toolSummary: [],
            errorMessage: null,
            wasStoppedByUser: false,
        };
    }
    const versions = response.getVersions();
    const current = response.getCurrentVersion();
    return {
        firstMessageId: response.messageId,
        versionCount: versions.length,
        currentVersion: current === null ? null : response.currentVersionIndex + 1,
        model: current === null ? null : modelOfVersion(current, response),
        text: current === null ? message.text : textOrNull(current.text),
        thinkingText: current === null ? null : textOrNull(current.thinkingText),
        toolSummary: current === null ? [] : toToolUsageViews(parseAgentStats(current.agentStats)),
        errorMessage: current === null ? null : textOrNull(current.errorMessage),
        wasStoppedByUser: current?.wasStoppedByUser === true,
    };
};

const attachmentsOf = (version: ResponseVersion): AttachmentView[] => {
    const attachments: AttachmentView[] = [];
    if (typeof version.imageBase64 === 'string' && version.imageBase64 !== '') {
        const head = Buffer.from(version.imageBase64.slice(0, BASE64_SNIFF_CHARS), 'base64');
        attachments.push({
            kind: version.sticker !== undefined ? 'sticker' : 'image',
            mimeType: sniffMediaMime(head),
            sizeBytes: base64ByteLength(version.imageBase64),
        });
    }
    if (version.widget !== undefined) {
        attachments.push({
            kind: 'widget',
            mimeType: 'text/html',
            sizeBytes: version.widget.htmlBytes,
        });
    }
    if (version.file !== undefined) {
        attachments.push({
            kind: 'file',
            mimeType: typeof version.file.mimeType === 'string' ? version.file.mimeType : null,
            sizeBytes:
                typeof version.file.sizeBytes === 'number'
                    ? version.file.sizeBytes
                    : base64ByteLength(version.fileBase64 ?? ''),
        });
    }
    return attachments;
};

const hasModelParts = (version: ResponseVersion): boolean => {
    const parts: unknown = version.modelParts;
    return Array.isArray(parts) ? parts.length > 0 : parts !== undefined && parts !== null;
};

const toVersionView = (
    version: ResponseVersion,
    response: BotResponse,
    metrics: ReplyMetricsView | null
): ReplyVersionView => ({
    versionId: version.versionId,
    createdAt: textOrNull(version.createdAt) ?? '',
    model: modelOfVersion(version, response),
    text: typeof version.text === 'string' ? version.text : '',
    thinkingText: textOrNull(version.thinkingText),
    tools: buildToolRecordsView(version.agentStats, version.groundingData),
    agentStats: parseAgentStats(version.agentStats),
    errorMessage: textOrNull(version.errorMessage),
    wasStoppedByUser: version.wasStoppedByUser === true,
    attachments: attachmentsOf(version),
    hasModelParts: hasModelParts(version),
    metrics,
});

/** The conversation root of a reply: through its trigger, else through its own row */
const rootIdOfReply = async (response: BotResponse): Promise<number | null> => {
    const viaTrigger = await findRootMessage(response.chatId, response.userMessageId, { recover: false });
    if (viaTrigger !== null) return viaTrigger.messageId;
    const viaReply = await findRootMessage(response.chatId, response.messageId, { recover: false });
    return viaReply?.messageId ?? null;
};

/** Every version of one reply, read-only */
export const buildReplyDetailView = async (
    response: BotResponse,
    access: VisibleAccess
): Promise<ReplyDetailView> => {
    const versions = response.getVersions();
    const metricsByVersion = await loadReplyMetrics(response.chatId, response.messageId, access);
    const current = response.getCurrentVersion();
    const commandType: unknown = response.getMetadata().commandType;
    const detail: ReplyDetailView = {
        firstMessageId: response.messageId,
        userMessageId: response.userMessageId,
        rootId: await rootIdOfReply(response),
        commandType: typeof commandType === 'string' ? commandType : null,
        generating: isBotReplyInFlight(response.chatId, response.messageId),
        versionCount: versions.length,
        currentVersion: current === null ? null : response.currentVersionIndex + 1,
        versions: versions.map((version) =>
            toVersionView(version, response, metricsByVersion?.get(version.versionId) ?? null)
        ),
    };
    if (access === 'observer') return detail;
    const trigger = await getMessage(response.chatId, response.userMessageId);
    return { ...detail, triggerUserId: trigger?.userId ?? null };
};
