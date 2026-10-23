/**
 * What a Gemini tool loop sends back after a round: the round's model turn
 * verbatim, then one user turn answering every function call it made.
 *
 * Parts are never merged or rewritten. Thought signatures ride on specific
 * parts, and every signature of the current turn's function calls must come
 * back (Vertex answers 400 otherwise), so each request repeats ALL earlier
 * tool rounds of the turn, not only the latest one.
 */
import type { Candidate, Content, FunctionCall, Part } from '@google/genai';
import type { ToolCall, ToolResult } from '../../tools/tool-types.js';

export interface GeminiToolRound {
    /** The round's model turn exactly as streamed */
    readonly modelParts: readonly Part[];
    /** One functionResponse per function call of the round, in call order */
    readonly responseParts: readonly Part[];
}

/** The contents round 1 sent, followed by every tool round so far */
export const buildRoundContents = (
    firstRoundContents: readonly Content[],
    toolRounds: readonly GeminiToolRound[]
): Content[] => [
    ...firstRoundContents,
    ...toolRounds.flatMap((round): Content[] => [
        { role: 'model', parts: [...round.modelParts] },
        { role: 'user', parts: [...round.responseParts] },
    ]),
];

/** An empty id counts as none */
const providerIdOf = (functionCall: FunctionCall): string | undefined =>
    functionCall.id === undefined || functionCall.id === '' ? undefined : functionCall.id;

/**
 * The calls as the tool layer runs them. A call Gemini gave no id gets
 * `call_<round>_<index>`; that id never goes back to Gemini.
 */
export const toToolCalls = (
    functionCalls: readonly FunctionCall[],
    roundNumber: number
): ToolCall[] =>
    functionCalls.map((functionCall, index) => ({
        id: providerIdOf(functionCall) ?? `call_${roundNumber}_${index}`,
        name: functionCall.name ?? '',
        argumentsJson: JSON.stringify(functionCall.args ?? {}),
    }));

const notRunResult = (name: string): ToolResult => ({
    content: `Tool ${name} was not run`,
    isError: true,
    images: [],
    record: null,
});

/**
 * Rides next to `output` / `error` in every function response of the last
 * round that may call functions. Vertex does not enforce mode NONE in the
 * final round, so the model is told in the turn itself that it must answer.
 */
export const LAST_TOOL_ROUND_NOTICE =
    'No more tool calls are available for this reply; answer the user now with what you have.';

export interface FunctionResponseOptions {
    /** The next request is the final round: each response carries LAST_TOOL_ROUND_NOTICE */
    readonly lastToolRound?: boolean;
}

/**
 * `{ output }` for a result, `{ error }` for a failure, plus the notice on the
 * last tool round; the id only when Gemini gave one
 */
const toFunctionResponsePart = (
    functionCall: FunctionCall,
    result: ToolResult,
    lastToolRound: boolean
): Part => {
    const id = providerIdOf(functionCall);
    // FunctionResponse.parts takes inlineData/fileData only: captions ride
    // response.output (a text part there is rejected with 400, 2026-10-23).
    const images = result.modelImages ?? [];
    return {
        functionResponse: {
            ...(id === undefined ? {} : { id }),
            name: functionCall.name ?? '',
            response: {
                ...(result.isError ? { error: result.content } : { output: result.content }),
                ...(lastToolRound ? { notice: LAST_TOOL_ROUND_NOTICE } : {}),
            },
            ...(images.length === 0
                ? {}
                : {
                      parts: images.map((image) => ({
                          inlineData: {
                              mimeType: image.mimeType,
                              data: image.data.toString('base64'),
                          },
                      })),
                  }),
        },
    };
};

/**
 * One functionResponse per function call, in call order: `results[i]` answers
 * `functionCalls[i]`. The count always matches the calls (Vertex rejects a
 * mismatch), so a missing result is answered as not run.
 */
export const buildFunctionResponseParts = (
    functionCalls: readonly FunctionCall[],
    results: readonly ToolResult[],
    options: FunctionResponseOptions = {}
): Part[] =>
    functionCalls.map((functionCall, index) =>
        toFunctionResponsePart(
            functionCall,
            results[index] ?? notRunResult(functionCall.name ?? ''),
            options.lastToolRound === true
        )
    );

/** What Gemini reads back for a call it made while function calling was off */
export const FUNCTION_CALLING_OFF_ERROR =
    'Not run: function calling is off for the rest of this reply; answer with what you already have.';

const functionCallingOffResult: ToolResult = {
    content: FUNCTION_CALLING_OFF_ERROR,
    isError: true,
    images: [],
    record: null,
};

/** Every call of a round answered as not run, because function calling is off (no notice) */
export const buildFunctionCallingOffParts = (functionCalls: readonly FunctionCall[]): Part[] =>
    buildFunctionResponseParts(
        functionCalls,
        functionCalls.map(() => functionCallingOffResult)
    );

/** A relay bug can hand candidates over as an object keyed 'undefined' */
const isCandidateList = (
    candidates: readonly Candidate[] | undefined
): candidates is readonly Candidate[] => Array.isArray(candidates);

/**
 * The chunk with functionCall parts dropped from its first candidate (a plain
 * copy then, without the SDK class getters). The done chunk's parts are
 * stored as modelParts and replayed in later turns, where a function call
 * without its response would be rejected.
 */
export const withoutFunctionCallParts = (response: { readonly candidates?: readonly Candidate[] }): unknown => {
    const candidates = response.candidates;
    if (!isCandidateList(candidates)) return response;

    const [firstCandidate, ...otherCandidates] = candidates;
    const parts = firstCandidate?.content?.parts;
    if (!firstCandidate || !parts || !parts.some((part) => part.functionCall !== undefined)) {
        return response;
    }

    return {
        ...response,
        candidates: [
            {
                ...firstCandidate,
                content: {
                    ...firstCandidate.content,
                    parts: parts.filter((part) => part.functionCall === undefined),
                },
            },
            ...otherCandidates,
        ],
    };
};
