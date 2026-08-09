/**
 * Turn a rough idea into a MiniMax H3 storyboard, using Grok.
 *
 * The instructions live in prompts/h3-video-prompt.md (see that file for
 * provenance); this module only decides which half of it applies, wraps the
 * user's idea in the brief template H3's preprocessor expects, and cleans up
 * what comes back.
 *
 * Deliberately not routed through src/ai: GrokPlatform attaches web_search,
 * x_search and code_interpreter to every call and runs an agent loop, which for
 * "expand one sentence into a storyboard" is pure latency on a path where the
 * user is already waiting.
 */
import { readFileSync } from 'node:fs';
import OpenAI from 'openai';
import { match } from 'ts-pattern';
import type { ResolvedVidMode } from '../reply/commands/vid-request-builder.js';

/** Resolved against the compiled file, so it doesn't depend on the cwd */
const DEFAULT_PROMPT_PATH = new URL('../../prompts/h3-video-prompt.md', import.meta.url);

const DEFAULT_MODEL = 'grok-4.5';

/** Long enough for a 500-word storyboard plus reasoning, short enough to fail fast */
const REQUEST_TIMEOUT_MS = 90_000;

/** The API's documented prompt cap */
const MAX_PROMPT_LENGTH = 10_000;

/**
 * The markers in the prompt file. Only one format block is ever sent: showing
 * the model a spec it must not follow is how you get a six-section answer to a
 * three-field question.
 */
const FORMAT_BLOCKS = {
    ref2va: /<!-- FORMAT:REF2VA -->([\s\S]*?)<!-- \/FORMAT:REF2VA -->/,
    base: /<!-- FORMAT:BASE -->([\s\S]*?)<!-- \/FORMAT:BASE -->/,
} as const;

const FORMAT_MARKERS = /<!--[\s\S]*?-->/g;

/** Whether the storyboard step can run at all */
export const isH3EnhancerConfigured = (): boolean => Boolean(process.env.GROK_API_KEY);

/**
 * Failures here are never fatal to the command — the caller falls back to
 * sending the user's own words — so they carry a short Chinese reason to show
 * alongside the degraded result.
 */
export class H3PromptError extends Error {
    readonly userReason: string;

    constructor(userReason: string, detail: string) {
        super(detail);
        this.name = 'H3PromptError';
        this.userReason = userReason;
    }
}

let cachedInstructions: string | null = null;

/**
 * Read once. A missing file is loud but not fatal: the built-in fallback is
 * enough to produce something H3 accepts, which beats refusing to make a video
 * because a markdown file moved.
 */
const readInstructions = (): string => {
    if (cachedInstructions !== null) return cachedInstructions;

    const path = process.env.H3_PROMPT_FILE ?? DEFAULT_PROMPT_PATH;
    try {
        cachedInstructions = readFileSync(path, 'utf-8');
    } catch (error) {
        console.error(`[h3] could not read the H3 instructions at ${String(path)}:`, error);
        cachedInstructions = FALLBACK_INSTRUCTIONS;
    }
    return cachedInstructions;
};

/** Test seam, and a way for a redeploy to pick up an edited file */
export const forgetH3Instructions = (): void => {
    cachedInstructions = null;
};

const FALLBACK_INSTRUCTIONS = [
    'You write MiniMax H3 video prompts. Output ONLY the fields below, no preamble,',
    'no markdown fences. Write in English except for dialogue inside <d> tags.',
    '',
    'integrated_multimodal_description: a timed multi-shot timeline. [Shot 1] has no',
    'timestamp and opens with the overall style; later shots open "[Shot N] At',
    'MM:SS.mmm, the camera cuts to ...". One dominant action per shot. Every shot',
    'states composition, camera motion (type + amplitude + speed), environment and',
    'lighting, and what is audible.',
    'overall_soundscape: 1-4 sentences of ambience and action sounds.',
    'non_diegetic_music: 1-3 sentences of score the characters cannot hear, or N/A.',
].join('\n');

/** The common half plus exactly the one format block this mode needs */
export const buildSystemPrompt = (mode: ResolvedVidMode): string => {
    const instructions = readInstructions();
    const wanted = mode === 'ref2va' ? 'ref2va' : 'base';

    const common = instructions
        .replace(FORMAT_BLOCKS.ref2va, '')
        .replace(FORMAT_BLOCKS.base, '')
        .replace(FORMAT_MARKERS, '')
        .trim();

    const block = instructions.match(FORMAT_BLOCKS[wanted])?.[1]?.trim() ?? '';

    return block ? `${common}\n\n${block}` : common;
};

export interface H3PromptRequest {
    /** The user's idea, in whatever language they wrote it */
    brief: string;
    mode: ResolvedVidMode;
    durationSeconds: number;
    /** Null when the output will follow the first frame instead */
    aspectRatio: string | null;
    shots: number | null;
    /** Base64 reference images, in the order they will be wired up */
    referenceImages: string[];
}

/**
 * What each attached image is for. The numbering is positional and has to match
 * the order the images are wired into the workflow, because that is what
 * `<Picture N>` resolves to on the far side.
 */
const describeImage = (mode: ResolvedVidMode, index: number): string =>
    match(mode)
        .with('i2va', () => 'the FIRST frame of the video — the shot starts exactly here')
        .with('fl2va', () =>
            index === 0
                ? 'the FIRST frame of the video'
                : 'the LAST frame of the video — the shot must land exactly here'
        )
        .otherwise(() => 'a character / appearance / scene reference, NOT a frame anchor');

/** The brief template H3's own preprocessor documentation asks for */
export const buildUserMessage = (request: H3PromptRequest): string => {
    const lines = ['BRIEF:', request.brief, '', `MODE: ${request.mode}`];

    const { referenceImages } = request;
    if (referenceImages.length > 0) {
        lines.push('', 'ASSETS:', 'Images:');
        referenceImages.forEach((_image, index) => {
            const role = describeImage(request.mode, index);
            lines.push(
                `${index + 1}. attached image ${index + 1} — ${role}. Refer to it as <Picture ${index + 1}>.`
            );
        });
    }

    lines.push('', 'TARGET:', `duration_s: ${request.durationSeconds}`);
    // I2V follows the first frame when no ratio is forced, so telling the model
    // a ratio that will not be sent would just make it compose for the wrong frame
    if (request.aspectRatio) lines.push(`ratio: ${request.aspectRatio}`);
    if (request.shots !== null) lines.push(`shots: ${request.shots}`);

    return lines.join('\n');
};

/** Where a well-formed answer starts, whichever format was asked for */
const FIELD_OPENERS = [
    'subject_definitions:',
    'integrated_multimodal_description:',
    'For the target video,',
    'How the reference pictures',
];

/**
 * Models add fences and "Here is your prompt:" no matter how firmly the system
 * prompt forbids it, and H3 would take both as scene direction.
 */
export const cleanStoryboard = (raw: string): string => {
    let text = raw.trim();

    // ```json ... ``` or plain ``` ... ```
    const fenced = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
    if (fenced?.[1]) text = fenced[1].trim();

    const starts = FIELD_OPENERS.map((opener) => text.indexOf(opener)).filter((at) => at > 0);
    if (starts.length > 0) text = text.slice(Math.min(...starts)).trim();

    if (text.length > MAX_PROMPT_LENGTH) {
        console.warn(`[h3] storyboard truncated from ${text.length} to ${MAX_PROMPT_LENGTH} chars`);
        text = text.slice(0, MAX_PROMPT_LENGTH);
    }

    return text;
};

let client: OpenAI | null = null;

const getClient = (): OpenAI => {
    client ??= new OpenAI({
        baseURL: process.env.GROK_API_URL,
        apiKey: process.env.GROK_API_KEY,
        maxRetries: 1,
    });
    return client;
};

/** Test seam: the base URL is read once when the client is built */
export const forgetH3Client = (): void => {
    client = null;
};

type UserContent = OpenAI.Chat.Completions.ChatCompletionContentPart[];

const buildContent = (request: H3PromptRequest): UserContent => {
    const content: UserContent = [{ type: 'text', text: buildUserMessage(request) }];

    // Vision matters here: "keep this character consistent" is unwriteable
    // without knowing what the character looks like
    for (const image of request.referenceImages) {
        content.push({
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${image}`, detail: 'auto' },
        });
    }

    return content;
};

/**
 * Expand an idea into an H3 storyboard. Throws `H3PromptError` on anything the
 * caller should degrade from rather than die on.
 */
export const enhanceVideoPrompt = async (request: H3PromptRequest): Promise<string> => {
    if (!isH3EnhancerConfigured()) {
        throw new H3PromptError('没有配置 Grok', 'GROK_API_KEY is empty');
    }

    const model = process.env.GROK_PROMPT_MODEL ?? DEFAULT_MODEL;
    const startedAt = Date.now();

    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
        completion = await getClient().chat.completions.create(
            {
                model,
                messages: [
                    { role: 'system', content: buildSystemPrompt(request.mode) },
                    { role: 'user', content: buildContent(request) },
                ],
            },
            { timeout: REQUEST_TIMEOUT_MS }
        );
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new H3PromptError(
            /timeout|aborted/i.test(detail) ? 'Grok 超时了' : 'Grok 没响应',
            `${model}: ${detail}`
        );
    }

    const raw = completion.choices[0]?.message?.content;
    if (typeof raw !== 'string' || !raw.trim()) {
        throw new H3PromptError('Grok 返回了空内容', `${model} returned no content`);
    }

    const storyboard = cleanStoryboard(raw);
    if (!storyboard) {
        throw new H3PromptError('Grok 返回了空内容', `${model} returned only boilerplate`);
    }

    console.log(
        `[h3] storyboard written by ${model} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
        { mode: request.mode, chars: storyboard.length, images: request.referenceImages.length }
    );
    return storyboard;
};
