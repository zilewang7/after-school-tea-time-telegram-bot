/**
 * One attempt of a Gemini tool loop round, consumed: text and thinking are
 * shown as they stream, while everything the next request needs is kept
 * aside. A stream that breaks is reported, not thrown: the round runner
 * decides whether the round is tried again, and what this attempt collected
 * (parts, calls, grounding) is dropped with it.
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
import type { ThoughtSummaryFilter } from './gemini-thought-summary.js';
import { headerOf, type GeminiRequestUsage } from './gemini-usage-log.js';
import type { OpenedGeminiRound } from './gemini-round-open.js';

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

/** A stream that threw after it had opened */
export interface BrokenGeminiRound {
    readonly kind: 'broken';
    readonly error: unknown;
    /** Text that is not blank, or an image, reached the user */
    readonly showedAnswer: boolean;
    /** Thinking that is not blank reached the user */
    readonly showedThinking: boolean;
    /** The leading chunk went out before the stream broke */
    readonly leadingShown: boolean;
    /** What the stream reported up to the break, for the failed-attempt log line */
    readonly usage: GeminiRequestUsage;
}

export type ConsumedGeminiRound =
    | { readonly kind: 'complete'; readonly round: CollectedGeminiRound }
    | BrokenGeminiRound;

/** Empty text parts (the usual signature carriers) show nothing */
const isVisible = (chunk: StreamChunk): boolean =>
    !((chunk.type === 'text' || chunk.type === 'thinking') && !chunk.content);

const isBlank = (chunk: StreamChunk): boolean => (chunk.content ?? '').trim() === '';

/**
 * Streams the attempt's text, thinking and images (blank line before a later
 * round's first text) and returns the round as collected, or how it broke.
 * Thinking goes through the thought-summary filter, which drops the
 * summarizer's own CoT and keeps its summaries; the last block is flushed
 * when the stream ends, and when it breaks, so a retry starts on a clean
 * filter. Grounding is not yielded here: each round repeats the turn's
 * searches so far. `leadingChunk` goes out right before the first visible
 * chunk.
 */
export async function* consumeGeminiRound(
    opened: OpenedGeminiRound,
    separator: RoundTextSeparator,
    viaLabel: string | undefined,
    thoughtSummary: ThoughtSummaryFilter,
    leadingChunk: StreamChunk | null = null
): AsyncGenerator<StreamChunk, ConsumedGeminiRound, void> {
    const parts: Part[] = [];
    const functionCalls: FunctionCall[] = [];
    const groundings: GroundingData[] = [];
    let showedText = false;
    let showedImage = false;
    let showedThinking = false;
    let leadingShown = false;
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

    const usageSoFar = (): GeminiRequestUsage => ({
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
    });

    /** The leading chunk goes out once, right before the first visible chunk */
    function* afterLeading(chunk: StreamChunk): Generator<StreamChunk, void, void> {
        if (leadingChunk !== null && !leadingShown) {
            leadingShown = true;
            yield leadingChunk;
        }
        yield chunk;
    }

    /** Thinking as the filter released it; nothing while a block is still arriving */
    function* shownThinking(content: string): Generator<StreamChunk, void, void> {
        if (content === '') return;
        const thinking: StreamChunk = { type: 'thinking', content };
        showedThinking ||= !isBlank(thinking);
        yield* afterLeading(thinking);
    }

    try {
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
                    // Only the summarizer's summaries are shown; its own CoT is not
                    yield* shownThinking(thoughtSummary.push(streamChunk.content ?? ''));
                    continue;
                }
                if (streamChunk.type === 'text') {
                    firstTextAt ??= Date.now();
                    showedText ||= !isBlank(streamChunk);
                } else if (streamChunk.type === 'image') {
                    showedImage = true;
                }
                yield* afterLeading(separator.apply(streamChunk));
            }

            const grounding = extractGroundingMetadata(chunk);
            if (grounding) {
                groundings.push(grounding);
                groundingSources += grounding.groundingChunks?.length ?? 0;
            }
        }
    } catch (error) {
        // The cut block gives up the summaries it has, and the filter holds
        // nothing of this attempt when the round is tried again
        yield* shownThinking(thoughtSummary.flush());
        return {
            kind: 'broken',
            error,
            showedAnswer: showedText || showedImage,
            showedThinking,
            leadingShown,
            usage: usageSoFar(),
        };
    }

    // The round ended: its last block is complete (or was cut by the end)
    yield* shownThinking(thoughtSummary.flush());

    return {
        kind: 'complete',
        round: {
            parts,
            functionCalls,
            showedText,
            finishReason,
            lastChunk,
            groundings,
            usage: usageSoFar(),
        },
    };
}
