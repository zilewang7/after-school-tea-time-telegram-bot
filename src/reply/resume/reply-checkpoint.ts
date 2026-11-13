/**
 * What the reply layer keeps of a failed or stopped reply so "继续" can pick it
 * up (design 2026-1112-1123 §6.2): the tool loop's own checkpoint, the state
 * of the reply's tools, the facts of the context build a resume reuses
 * instead of rebuilding, and the facts the click-time validation compares.
 *
 * An entry is plain data and the tool state objects. It never references the
 * session, the ChatContext, a stream, an abort signal, the Bot API or a model
 * client: those belong to one attempt, and the entry outlives it.
 */
import type { ThinkingEffortValue } from '../../services/thinking-effort-values.js';
import type { ToolLoopCheckpoint } from '../../ai/tools/tool-loop-checkpoint.js';
import type { ContextIndex } from '../context-index.js';
import type { ReplyToolState } from '../tools/reply-tool-state.js';

/** The context as it was built for the interrupted version */
export interface ResumeContextFacts {
    /** `#N` → message id, as buildContext published it for the display links */
    readonly numbering: ReadonlyMap<number, number>;
    /** `#N` → message, with its pictures, as the tools resolve it */
    readonly contextIndex: ContextIndex;
    /** Reply-tree roots of the context, the trigger's own conversation first */
    readonly conversationRootIds: readonly number[];
    /** The chat's prompt addendum the context was built with */
    readonly promptAddendum: string | null;
    /** Epoch ms of the build */
    readonly builtAt: number;
    /** Every message of the context, for the context-exclusion check */
    readonly contextMessageIds: readonly number[];
}

/** What the request was made of; a continue may only send the same */
export interface ResumeRequestFacts {
    readonly model: string;
    /** The system prompt text, byte for byte */
    readonly systemPrompt: string;
    /** The tool definitions as canonical JSON (keys sorted) */
    readonly toolDefinitionsJson: string;
    /** The chat's thinking level setting as it was; null = the model default */
    readonly thinkingEffort: ThinkingEffortValue | null;
    /** The level that actually went out after clamping; null = nothing explicit */
    readonly thinkingEffortSent: string | null;
}

/**
 * Captured where a reply builds its context and tools, before the request goes
 * out. With the last tool loop checkpoint and the failed version it becomes a
 * ReplyCheckpoint, without rebuilding anything at failure time.
 */
export interface ReplyResumeFacts {
    /** Shared with the running tools by reference: it ends as the last snapshot left it */
    readonly toolState: ReplyToolState;
    readonly context: ResumeContextFacts;
    readonly request: ResumeRequestFacts;
}

/** One kept checkpoint: at most one per reply, keyed by chatId:firstMessageId */
export interface ReplyCheckpoint extends ReplyResumeFacts {
    readonly chatId: number;
    readonly firstMessageId: number;
    /** The message the reply answers */
    readonly userMessageId: number;
    /** The tool loop's checkpoint, its journal compacted */
    readonly loop: ToolLoopCheckpoint;
    /** The failed or stopped version a continue picks up */
    readonly failedVersionId: number;
    /** Epoch ms of the save; the entry lives for a fixed time from here */
    readonly savedAt: number;
}
