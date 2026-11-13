/**
 * The shape of a reply_metrics row, and reading one back from a raw query.
 * Raw rows come back as SQLite stores them (DATE as text, BOOLEAN as 0 / 1,
 * toolUsage as JSON text), so every field goes through a guard; a row that
 * does not fit is skipped rather than guessed at.
 */
import { ERROR_KINDS, type ErrorKind } from '../../shared/error-kind.js';
import { isJsonObject } from '../../shared/json-object.js';

export type ReplyOutcome = 'ok' | 'error' | 'stopped' | 'empty';

export const REPLY_OUTCOMES: readonly ReplyOutcome[] = ['ok', 'error', 'stopped', 'empty'];

/** What a reply asked Vertex for; only Priority PayGo exists (standard requests store NULL) */
export type RequestedTier = 'priority';

export const REQUESTED_TIERS: readonly RequestedTier[] = ['priority'];

export interface ToolUsageEntry {
    readonly name: string;
    readonly count: number;
    readonly failed: number;
}

/** Everything one row stores; `toolUsage` is empty when no tool ran */
export interface ReplyMetricInput {
    readonly chatId: number;
    readonly userMessageId: number;
    readonly firstMessageId: number;
    readonly versionId: number;
    readonly triggerUserId: number | null;
    readonly model: string;
    readonly platform: string;
    readonly route: string | null;
    readonly commandType: string;
    readonly isRetry: boolean;
    readonly startedAt: Date;
    readonly requestStartedAt: Date | null;
    readonly firstChunkAt: Date | null;
    readonly finishedAt: Date;
    readonly outcome: ReplyOutcome;
    readonly errorKind: ErrorKind | null;
    readonly errorSummary: string | null;
    readonly rounds: number | null;
    readonly toolCalls: number;
    readonly toolFailures: number;
    readonly toolUsage: readonly ToolUsageEntry[];
    readonly promptTokens: number | null;
    readonly cachedTokens: number | null;
    readonly cacheWriteTokens: number | null;
    readonly outputTokens: number | null;
    readonly thoughtsTokens: number | null;
    readonly imageOutputTokens: number | null;
    readonly contextMessages: number | null;
    readonly contextImages: number | null;
    readonly textChars: number | null;
    readonly thinkingChars: number | null;
    readonly hasImage: boolean;
    readonly imageCount: number;
    readonly hasSticker: boolean;
    readonly hasFile: boolean;
    /** Failed round attempts retried automatically; null when there was none */
    readonly roundRetries: number | null;
    /** Set when the Priority PayGo header went out with the requests */
    readonly tierRequested: RequestedTier | null;
    /** Rounds served at the priority tier and their tokens; all null when none was */
    readonly priorityRounds: number | null;
    readonly priorityPromptTokens: number | null;
    readonly priorityCachedTokens: number | null;
    /** Reasoning included, like outputTokens */
    readonly priorityOutputTokens: number | null;
    /** Rounds carried over from a checkpoint; null when the attempt is not a resume */
    readonly resumedRounds: number | null;
    /** Rounds the checkpoint saved when this attempt failed or stopped; null when none was saved */
    readonly checkpointRounds: number | null;
    /**
     * The thinking-effort columns. Optional on the input so a caller writing a
     * row without them stores NULL (rows from before the feature, fixtures);
     * a stored row always carries them, which the record below states.
     */
    readonly thinkingEffortRequested?: string | null;
    readonly thinkingEffortSent?: string | null;
    readonly thinkingEffortFallback?: string | null;
}

export interface ReplyMetricRecord extends ReplyMetricInput {
    readonly id: number;
    readonly thinkingEffortRequested: string | null;
    readonly thinkingEffortSent: string | null;
    readonly thinkingEffortFallback: string | null;
}

const integerOrNull = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** SQLite gives 0 / 1; a model instance would give a boolean */
const booleanOf = (value: unknown): boolean => value === true || value === 1;

/** DATE columns come back as `YYYY-MM-DD HH:MM:SS.SSS +00:00` text from raw queries */
export const storedDateOf = (value: unknown): Date | null => {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value !== 'string') return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const outcomeOf = (value: unknown): ReplyOutcome | null =>
    REPLY_OUTCOMES.find((outcome) => outcome === value) ?? null;

const errorKindOf = (value: unknown): ErrorKind | null => ERROR_KINDS.find((kind) => kind === value) ?? null;

const requestedTierOf = (value: unknown): RequestedTier | null =>
    REQUESTED_TIERS.find((tier) => tier === value) ?? null;

const toolUsageEntryOf = (value: unknown): ToolUsageEntry | null => {
    if (!isJsonObject(value) || typeof value.name !== 'string') return null;
    const count = integerOrNull(value.count);
    if (count === null) return null;
    return { name: value.name, count, failed: integerOrNull(value.failed) ?? 0 };
};

const parseToolUsage = (value: unknown): ToolUsageEntry[] => {
    if (typeof value !== 'string' || value === '') return [];
    try {
        const parsed: unknown = JSON.parse(value);
        if (!Array.isArray(parsed)) return [];
        return parsed.flatMap((entry) => {
            const usage = toolUsageEntryOf(entry);
            return usage === null ? [] : [usage];
        });
    } catch {
        return [];
    }
};

/** The stored JSON of toolUsage; NULL when no tool ran */
export const serializeToolUsage = (entries: readonly ToolUsageEntry[]): string | null =>
    entries.length === 0 ? null : JSON.stringify(entries);

/** One raw row; null when a required field is missing or malformed */
export const parseReplyMetricRow = (row: unknown): ReplyMetricRecord | null => {
    if (!isJsonObject(row)) return null;
    const id = integerOrNull(row.id);
    const chatId = integerOrNull(row.chatId);
    const userMessageId = integerOrNull(row.userMessageId);
    const firstMessageId = integerOrNull(row.firstMessageId);
    const versionId = integerOrNull(row.versionId);
    const startedAt = storedDateOf(row.startedAt);
    const finishedAt = storedDateOf(row.finishedAt);
    const outcome = outcomeOf(row.outcome);
    if (
        id === null ||
        chatId === null ||
        userMessageId === null ||
        firstMessageId === null ||
        versionId === null ||
        startedAt === null ||
        finishedAt === null ||
        outcome === null ||
        typeof row.model !== 'string' ||
        typeof row.platform !== 'string' ||
        typeof row.commandType !== 'string'
    ) {
        return null;
    }

    return {
        id,
        chatId,
        userMessageId,
        firstMessageId,
        versionId,
        triggerUserId: integerOrNull(row.triggerUserId),
        model: row.model,
        platform: row.platform,
        route: stringOrNull(row.route),
        commandType: row.commandType,
        isRetry: booleanOf(row.isRetry),
        startedAt,
        requestStartedAt: storedDateOf(row.requestStartedAt),
        firstChunkAt: storedDateOf(row.firstChunkAt),
        finishedAt,
        outcome,
        errorKind: errorKindOf(row.errorKind),
        errorSummary: stringOrNull(row.errorSummary),
        rounds: integerOrNull(row.rounds),
        toolCalls: integerOrNull(row.toolCalls) ?? 0,
        toolFailures: integerOrNull(row.toolFailures) ?? 0,
        toolUsage: parseToolUsage(row.toolUsage),
        promptTokens: integerOrNull(row.promptTokens),
        cachedTokens: integerOrNull(row.cachedTokens),
        cacheWriteTokens: integerOrNull(row.cacheWriteTokens),
        outputTokens: integerOrNull(row.outputTokens),
        thoughtsTokens: integerOrNull(row.thoughtsTokens),
        imageOutputTokens: integerOrNull(row.imageOutputTokens),
        contextMessages: integerOrNull(row.contextMessages),
        contextImages: integerOrNull(row.contextImages),
        textChars: integerOrNull(row.textChars),
        thinkingChars: integerOrNull(row.thinkingChars),
        hasImage: booleanOf(row.hasImage),
        imageCount: integerOrNull(row.imageCount) ?? 0,
        hasSticker: booleanOf(row.hasSticker),
        hasFile: booleanOf(row.hasFile),
        roundRetries: integerOrNull(row.roundRetries),
        tierRequested: requestedTierOf(row.tierRequested),
        priorityRounds: integerOrNull(row.priorityRounds),
        priorityPromptTokens: integerOrNull(row.priorityPromptTokens),
        priorityCachedTokens: integerOrNull(row.priorityCachedTokens),
        priorityOutputTokens: integerOrNull(row.priorityOutputTokens),
        resumedRounds: integerOrNull(row.resumedRounds),
        checkpointRounds: integerOrNull(row.checkpointRounds),
        thinkingEffortRequested: stringOrNull(row.thinkingEffortRequested),
        thinkingEffortSent: stringOrNull(row.thinkingEffortSent),
        thinkingEffortFallback: stringOrNull(row.thinkingEffortFallback),
    };
};
