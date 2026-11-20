/**
 * The facts a kept checkpoint needs besides the tool loop's own, taken where a
 * reply builds its context and tools (chat handler, retry handler). Nothing is
 * rebuilt at failure time: the failure only adds the last checkpoint and the
 * failed version.
 */
import type { TurnTools } from '../../ai/tools/tool-types.js';
import type { RuntimeTraits } from '../../ai/types.js';
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
    /**
     * The display numbering buildContext just published, when the caller has
     * it: a bot reply's number opens the message its body starts in, which the
     * context index does not know. Falls back to the index's own ids.
     */
    readonly numbering?: ReadonlyMap<number, number>;
    readonly conversationRootIds: readonly number[];
    /** The combined addendum (templates + custom) the context was built with */
    readonly promptAddendum: string | null;
    /** Session-side inputs of that combination: the custom text, the manually enabled ids and the auto switch */
    readonly promptAddendumCustom: string | null;
    readonly promptTemplateIds: readonly number[] | null;
    readonly promptTemplatesAuto: boolean;
    /** The chat's thinking level setting the request used; null = the model default */
    readonly thinkingEffort?: ThinkingEffortValue | null;
    /** What that setting resolved to for this request's model; null = nothing explicit */
    readonly thinkingEffortSent?: string | null;
    /** Pre-resolved traits for the attempt so continue can detect data changes */
    readonly traits?: RuntimeTraits;
    /** Epoch ms the context was built */
    readonly builtAt: number;
}

/** `#N` → message id from the context index alone; the fallback when the published numbering is gone */
const numberingOf = (contextIndex: ContextIndex): Map<number, number> =>
    new Map([...contextIndex].map(([number, entry]) => [number, entry.messageId] as const));

export const THINKING_EFFORT_CHANGED_NOTICE = '思考档位已修改，改回后可继续，或点重试';
export const THINKING_EFFORT_DATA_CHANGED_NOTICE = '模型的思考档位数据已变化，点重试可继续';
export const MODEL_CAPABILITIES_CHANGED_NOTICE = '模型的能力数据已变化，点重试可继续';

/**
 * What would differ between the interrupted version and a continue click, or
 * null when nothing would: 'setting-changed' is the chat's own value, while
 * 'model-data-changed' is the same value resolving to another level because
 * the catalog/seed data changed under it (there is nothing to change back).
 */
export type ThinkingEffortChange = 'setting-changed' | 'model-data-changed';

export const thinkingEffortChangeOf = (
    settings: { readonly thinkingEffort: ThinkingEffortValue | null },
    request: ResumeRequestFacts,
    traits?: RuntimeTraits
): ThinkingEffortChange | null => {
    if (settings.thinkingEffort !== request.thinkingEffort) return 'setting-changed';
    // The level that would go out is part of the request shape too.
    const resolved = sentEffortOf(resolveThinkingEffort(request.model, settings.thinkingEffort, traits));
    return resolved === request.thinkingEffortSent ? null : 'model-data-changed';
};

/** The refusal notice a continue click would carry, or null when the request shape matches */
export const thinkingEffortRefusalNoticeOf = (
    settings: { readonly thinkingEffort: ThinkingEffortValue | null },
    request: ResumeRequestFacts,
    traits?: RuntimeTraits
): string | null => {
    const change = thinkingEffortChangeOf(settings, request, traits);
    if (change === 'setting-changed') return THINKING_EFFORT_CHANGED_NOTICE;
    if (change === 'model-data-changed') return THINKING_EFFORT_DATA_CHANGED_NOTICE;
    return null;
};

/** Detect whether media/vision/output-token traits changed since the checkpoint was captured */
export const modelCapabilitiesChangedNoticeOf = (
    traits: RuntimeTraits,
    request: ResumeRequestFacts
): string | null => {
    if (request.imageInput !== undefined && traits.imageInput.value !== request.imageInput) {
        return MODEL_CAPABILITIES_CHANGED_NOTICE;
    }
    if (request.mediaInput !== undefined && traits.mediaInput.value !== request.mediaInput) {
        return MODEL_CAPABILITIES_CHANGED_NOTICE;
    }
    if (request.outputTokens !== undefined && traits.outputTokens.value !== request.outputTokens) {
        return MODEL_CAPABILITIES_CHANGED_NOTICE;
    }
    return null;
};

export const captureResumeFacts = (input: ResumeFactsInput): ReplyResumeFacts => ({
    toolState: input.toolState,
    context: {
        numbering: input.numbering ?? numberingOf(input.contextIndex),
        contextIndex: input.contextIndex,
        conversationRootIds: [...input.conversationRootIds],
        promptAddendum: input.promptAddendum,
        promptAddendumCustom: input.promptAddendumCustom,
        promptTemplateIds: input.promptTemplateIds,
        promptTemplatesAuto: input.promptTemplatesAuto,
        builtAt: input.builtAt,
        contextMessageIds: [...input.contextIndex.values()].map((entry) => entry.messageId),
    },
    request: {
        model: input.model,
        systemPrompt: input.systemPrompt,
        toolDefinitionsJson: toolDefinitionsJsonOf(input.tools.definitions),
        thinkingEffort: input.thinkingEffort ?? null,
        thinkingEffortSent: input.thinkingEffortSent ?? null,
        ...(input.traits === undefined
            ? {}
            : {
                  imageInput: input.traits.imageInput.value,
                  mediaInput: input.traits.mediaInput.value,
                  outputTokens: input.traits.outputTokens.value,
              }),
    },
});
