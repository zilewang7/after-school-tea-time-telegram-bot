/**
 * One round of a Gemini tool loop, consumed: text and thinking are shown as
 * they stream, while everything the next request needs is kept aside.
 */
import type {
    FinishReason,
    FunctionCall,
    GenerateContentResponse,
    Part,
} from '@google/genai';
import type { GroundingData, StreamChunk } from '../../types.js';
import type { RoundTextSeparator } from '../../tools/round-text-separator.js';
import { extractGroundingMetadata } from './gemini-grounding.js';
import { geminiPartToChunk } from './gemini-part-chunks.js';
import { headerOf, type GeminiRequestUsage } from './gemini-usage-log.js';
import type { OpenedGeminiRound } from './gemini-first-round.js';

export interface CollectedGeminiRound {
    /** Every part of the round in arrival order, untouched (signatures ride on them) */
    readonly parts: readonly Part[];
    /** The function calls among those parts, in order */
    readonly functionCalls: readonly FunctionCall[];
    /** The round showed text that is not blank (thinking does not count) */
    readonly showedText: boolean;
    readonly finishReason: FinishReason | undefined;
    /** Null only when the stream carried no chunk at all */
    readonly lastChunk: GenerateContentResponse | null;
    /** Search grounding as each chunk reported it; merged once per reply */
    readonly groundings: readonly GroundingData[];
    readonly usage: GeminiRequestUsage;
}

/** Empty text parts (the usual signature carriers) show nothing */
const isVisible = (chunk: StreamChunk): boolean =>
    !((chunk.type === 'text' || chunk.type === 'thinking') && !chunk.content);

/**
 * Streams the round's text, thinking and images (blank line before a later
 * round's first text) and returns the round as collected. Grounding is not
 * yielded here: each round repeats the turn's searches so far.
 */
export async function* consumeGeminiRound(
    opened: OpenedGeminiRound,
    separator: RoundTextSeparator,
    viaLabel: string | undefined
): AsyncGenerator<StreamChunk, CollectedGeminiRound, void> {
    const parts: Part[] = [];
    const functionCalls: FunctionCall[] = [];
    const groundings: GroundingData[] = [];
    let showedText = false;
    let finishReason: FinishReason | undefined;
    let lastChunk: GenerateContentResponse | null = null;
    let routedVia: string | null = null;
    let fallbackAttempts: string | null = null;
    let firstPartAt: number | null = null;
    let firstThinkAt: number | null = null;
    let firstTextAt: number | null = null;
    let groundingSources = 0;
    let chunkCount = 0;
    let maxChunkGapMs = 0;
    let maxChunkGapAtMs: number | null = null;
    let previousChunkAt: number | null = null;

    for await (const chunk of opened.stream) {
        const chunkAt = Date.now();
        chunkCount += 1;
        if (previousChunkAt !== null && chunkAt - previousChunkAt > maxChunkGapMs) {
            maxChunkGapMs = chunkAt - previousChunkAt;
            maxChunkGapAtMs = chunkAt - opened.requestStartedAt;
        }
        previousChunkAt = chunkAt;
        lastChunk = chunk;
        routedVia ??= headerOf(chunk, 'x-axonhub-routed-via');
        fallbackAttempts ??= headerOf(chunk, 'x-axonhub-fallback-attempts');
        const candidate = chunk.candidates?.[0];
        finishReason = candidate?.finishReason ?? finishReason;

        for (const part of candidate?.content?.parts ?? []) {
            parts.push(part);
            if (part.functionCall) {
                functionCalls.push(part.functionCall);
            }

            const streamChunk = geminiPartToChunk(part);
            if (streamChunk === null || !isVisible(streamChunk)) continue;

            firstPartAt ??= Date.now();
            if (streamChunk.type === 'thinking') {
                firstThinkAt ??= Date.now();
            } else if (streamChunk.type === 'text') {
                firstTextAt ??= Date.now();
                if ((streamChunk.content ?? '').trim() !== '') {
                    showedText = true;
                }
            }
            yield separator.apply(streamChunk);
        }

        const grounding = extractGroundingMetadata(chunk);
        if (grounding) {
            groundings.push(grounding);
            groundingSources += grounding.groundingChunks?.length ?? 0;
        }
    }

    return {
        parts,
        functionCalls,
        showedText,
        finishReason,
        lastChunk,
        groundings,
        usage: {
            via: routedVia ?? viaLabel ?? '-',
            fallbackAttempts,
            usage: lastChunk?.usageMetadata,
            groundingCount: groundings.length,
            groundingSources,
            requestStartedAt: opened.requestStartedAt,
            streamOpenedAt: opened.streamOpenedAt,
            firstPartAt,
            firstThinkAt,
            firstTextAt,
            finishedAt: Date.now(),
            chunkCount,
            maxChunkGapMs,
            maxChunkGapAtMs,
        },
    };
}
