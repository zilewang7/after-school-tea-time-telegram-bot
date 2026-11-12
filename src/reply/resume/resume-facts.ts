/**
 * The facts a kept checkpoint needs besides the tool loop's own, taken where a
 * reply builds its context and tools (chat handler, retry handler). Nothing is
 * rebuilt at failure time: the failure only adds the last checkpoint and the
 * failed version.
 */
import type { TurnTools } from '../../ai/tools/tool-types.js';
import type { ContextIndex } from '../context-index.js';
import type { ReplyToolState } from '../tools/reply-tool-state.js';
import type { ToolRequestTraits } from '../tools/tool-availability.js';
import { toolDefinitionsJsonOf } from './canonical-json.js';
import type { ReplyResumeFacts } from './reply-checkpoint.js';

export interface ResumeFactsInput {
    readonly model: string;
    /** The system prompt the request carries */
    readonly systemPrompt: string;
    /** Only the definitions are read; the handlers hold the attempt's signal and api */
    readonly tools: TurnTools;
    readonly toolState: ReplyToolState;
    readonly contextIndex: ContextIndex;
    readonly conversationRootIds: readonly number[];
    readonly requestTraits: ToolRequestTraits;
    readonly promptAddendum: string | null;
    /** Epoch ms the context was built */
    readonly builtAt: number;
}

/** `#N` → message id; the same numbering buildContext published for the links */
const numberingOf = (contextIndex: ContextIndex): Map<number, number> =>
    new Map([...contextIndex].map(([number, entry]) => [number, entry.messageId] as const));

export const captureResumeFacts = (input: ResumeFactsInput): ReplyResumeFacts => ({
    toolState: input.toolState,
    context: {
        numbering: numberingOf(input.contextIndex),
        contextIndex: input.contextIndex,
        conversationRootIds: [...input.conversationRootIds],
        requestTraits: { carriesLargeMedia: input.requestTraits.carriesLargeMedia },
        promptAddendum: input.promptAddendum,
        builtAt: input.builtAt,
        contextMessageIds: [...input.contextIndex.values()].map((entry) => entry.messageId),
    },
    request: {
        model: input.model,
        systemPrompt: input.systemPrompt,
        toolDefinitionsJson: toolDefinitionsJsonOf(input.tools.definitions),
    },
});
