/**
 * The facts a kept checkpoint needs besides the tool loop's own, taken where a
 * reply builds its context and tools (chat handler, retry handler). Nothing is
 * rebuilt at failure time: the failure only adds the last checkpoint and the
 * failed version.
 */
import type { TurnTools } from '../../ai/tools/tool-types.js';
import type { ThinkingEffortValue } from '../../services/thinking-effort-values.js';
import type { ContextIndex } from '../context-index.js';
import type { ReplyToolState } from '../tools/reply-tool-state.js';
import { toolDefinitionsJsonOf } from './canonical-json.js';
import { resolveThinkingEffort, sentEffortOf } from '../../ai/thinking-effort.js';
import type { ReplyResumeFacts, ResumeRequestFacts } from './reply-checkpoint.js';

export interface ResumeFactsInput {
    readonly model: string;
    /** The system prompt the request carries */
    readonly systemPrompt: string;
    /** Only the definitions are read; the handlers hold the attempt's signal and api */
    readonly tools: TurnTools;
    readonly toolState: ReplyToolState;
    readonly contextIndex: ContextIndex;
    readonly conversationRootIds: readonly number[];
    readonly promptAddendum: string | null;
    /** The chat's thinking level setting the request used; null = the model default */
    readonly thinkingEffort?: ThinkingEffortValue | null;
    /** What that setting resolved to for this request's model; null = nothing explicit */
    readonly thinkingEffortSent?: string | null;
    /** Epoch ms the context was built */
    readonly builtAt: number;
}

/** `#N` → message id; the same numbering buildContext published for the links */
const numberingOf = (contextIndex: ContextIndex): Map<number, number> =>
    new Map([...contextIndex].map(([number, entry]) => [number, entry.messageId] as const));

export const THINKING_EFFORT_CHANGED_NOTICE = '思考档位已修改，改回后可继续，或点重试';
export const THINKING_EFFORT_DATA_CHANGED_NOTICE = '模型的思考档位数据已变化，点重试可继续';

/**
 * What would differ between the interrupted version and a continue click, or
 * null when nothing would: 'setting-changed' is the chat's own value, while
 * 'model-data-changed' is the same value resolving to another level because
 * the catalog/seed data changed under it (there is nothing to change back).
 */
export type ThinkingEffortChange = 'setting-changed' | 'model-data-changed';

export const thinkingEffortChangeOf = (
    settings: { readonly thinkingEffort: ThinkingEffortValue | null },
    request: ResumeRequestFacts
): ThinkingEffortChange | null => {
    if (settings.thinkingEffort !== request.thinkingEffort) return 'setting-changed';
    // The level that would go out is part of the request shape too.
    const resolved = sentEffortOf(resolveThinkingEffort(request.model, settings.thinkingEffort));
    return resolved === request.thinkingEffortSent ? null : 'model-data-changed';
};

/** The refusal notice a continue click would carry, or null when the request shape matches */
export const thinkingEffortRefusalNoticeOf = (
    settings: { readonly thinkingEffort: ThinkingEffortValue | null },
    request: ResumeRequestFacts
): string | null => {
    const change = thinkingEffortChangeOf(settings, request);
    if (change === 'setting-changed') return THINKING_EFFORT_CHANGED_NOTICE;
    if (change === 'model-data-changed') return THINKING_EFFORT_DATA_CHANGED_NOTICE;
    return null;
};

export const captureResumeFacts = (input: ResumeFactsInput): ReplyResumeFacts => ({
    toolState: input.toolState,
    context: {
        numbering: numberingOf(input.contextIndex),
        contextIndex: input.contextIndex,
        conversationRootIds: [...input.conversationRootIds],
        promptAddendum: input.promptAddendum,
        builtAt: input.builtAt,
        contextMessageIds: [...input.contextIndex.values()].map((entry) => entry.messageId),
    },
    request: {
        model: input.model,
        systemPrompt: input.systemPrompt,
        toolDefinitionsJson: toolDefinitionsJsonOf(input.tools.definitions),
        thinkingEffort: input.thinkingEffort ?? null,
        thinkingEffortSent: input.thinkingEffortSent ?? null,
    },
});
