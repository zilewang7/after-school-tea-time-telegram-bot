/**
 * What a reply notes about itself while it runs, for the reply_metrics row
 * its finalize writes (design §6.5). Created with the session; the handlers
 * mark when the request goes out and how big the context was, the stream
 * processor the first chunk, and the platform reports every round's usage
 * into the sink.
 */
import { platformTypeOf } from '../ai/platform-routing.js';
import type { AgentToolUsage, PlatformType, StreamChunk } from '../ai/types.js';
import { createUsageSink } from '../ai/usage/usage-sink.js';
import type { UsageSink } from '../ai/usage/usage-types.js';
import type { CommandType } from '../db/botResponseDTO.js';
import type { ContextIndex } from '../reply/context-index.js';

export interface ReplyMetricsDraft {
    readonly platform: PlatformType;
    readonly commandType: CommandType;
    /** The session was created: the placeholder went out, the context is still to be built */
    readonly startedAt: Date;
    /** Who caused this attempt: the trigger's author, or whoever pressed retry */
    readonly triggerUserId: number | null;
    /** Right before sendMessage; null while the reply has not sent its request */
    requestStartedAt: Date | null;
    /** The first text or thinking chunk that was not empty */
    firstChunkAt: Date | null;
    /** Messages in the built context; null for image commands, which have none */
    contextMessages: number | null;
    /** Pictures in the built context, or an image command's reference images */
    contextImages: number | null;
    /** Thinking characters as streamed, before the display truncates them */
    thinkingChars: number;
    /** Rounds this attempt carried over from a checkpoint; null when it is not a resume */
    resumedRounds: number | null;
    /**
     * A resume: the tool usage the checkpoint brought along. The session's
     * usage stays cumulative for display; the row counts only what is above it.
     */
    toolUsageBaseline: readonly AgentToolUsage[];
    /** Rounds the checkpoint saved when this attempt failed or stopped; null when none was saved */
    checkpointRounds: number | null;
    /** The chat's thinking level when the attempt started; null = the model default */
    thinkingEffortRequested: string | null;
    /** What the platform actually sent after clamping/fallback; null = nothing explicit */
    thinkingEffortSent: string | null;
    /** The degradation chain, e.g. 'xhigh->high'; null = none */
    thinkingEffortFallback: string | null;
    /** Passed to the platform with the request */
    readonly usage: UsageSink;
}

export interface ReplyMetricsDraftInput {
    readonly model: string;
    readonly commandType: CommandType;
    readonly triggerUserId: number | null;
}

export const createReplyMetricsDraft = (input: ReplyMetricsDraftInput): ReplyMetricsDraft => ({
    platform: platformTypeOf(input.model),
    commandType: input.commandType,
    startedAt: new Date(),
    triggerUserId: input.triggerUserId,
    requestStartedAt: null,
    firstChunkAt: null,
    contextMessages: null,
    contextImages: null,
    thinkingChars: 0,
    resumedRounds: null,
    toolUsageBaseline: [],
    checkpointRounds: null,
    thinkingEffortRequested: null,
    thinkingEffortSent: null,
    thinkingEffortFallback: null,
    usage: createUsageSink(),
});

/** Call right before sendMessage; a failure before this point is a pre-request one */
export const markRequestStarted = (draft: ReplyMetricsDraft): void => {
    draft.requestStartedAt ??= new Date();
};

/** The context buildContext assembled: its messages and their pictures */
export const recordContextSize = (draft: ReplyMetricsDraft, contextIndex: ContextIndex): void => {
    draft.contextMessages = contextIndex.size;
    draft.contextImages = [...contextIndex.values()].reduce((sum, entry) => sum + entry.imageCount, 0);
};

/** Image commands build no context: their reference images are all the model sees */
export const recordReferenceImages = (draft: ReplyMetricsDraft, imageCount: number): void => {
    draft.contextMessages = null;
    draft.contextImages = imageCount;
};

/**
 * A resume: the rounds the checkpoint brought along and the tool calls they
 * made, both already recorded on the attempt it continues
 */
export const recordResumedRounds = (
    draft: ReplyMetricsDraft,
    rounds: number,
    toolUsageBaseline: readonly AgentToolUsage[] = []
): void => {
    draft.resumedRounds = rounds;
    draft.toolUsageBaseline = toolUsageBaseline.map((usage) => ({ ...usage }));
};

/** A failed or stopped attempt saved a checkpoint holding this many rounds */
export const recordCheckpointRounds = (draft: ReplyMetricsDraft, rounds: number): void => {
    draft.checkpointRounds = rounds;
};

/** What the thinking level resolved to, recorded where the request is built */
export const recordThinkingEffort = (
    draft: ReplyMetricsDraft,
    facts: {
        /** The chat setting as it was when the reply started */
        readonly requested: string | null;
        /** The level actually sent after clamping/fallback; null = nothing explicit went out */
        readonly sent: string | null;
        /** The degradation chain, e.g. 'xhigh->high' */
        readonly fallback?: string | null;
    }
): void => {
    draft.thinkingEffortRequested = facts.requested;
    draft.thinkingEffortSent = facts.sent;
    draft.thinkingEffortFallback = facts.fallback ?? null;
};

/**
 * One chunk as the stream processor receives it. Empty text parts do not
 * count as the first chunk: Gemini sends them to carry signatures. A chunk
 * replayed from a checkpoint is no first chunk either (the model sent nothing
 * yet), but its thinking is part of the version and counts.
 */
export const noteStreamChunk = (draft: ReplyMetricsDraft, chunk: StreamChunk): void => {
    if (chunk.type !== 'text' && chunk.type !== 'thinking') return;
    const content = chunk.content ?? '';
    if (content === '') return;
    if (chunk.replay !== true) draft.firstChunkAt ??= new Date();
    if (chunk.type === 'thinking') draft.thinkingChars += content.length;
};
