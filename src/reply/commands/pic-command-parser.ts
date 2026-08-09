/**
 * `/pic` and `/picunsafe` syntax.
 *
 * Shape: `/pic [-key=value ...] <prompt> [-: negative | -!: negative]`
 *
 * The `-key=value` scanning itself lives in command-flags.ts, shared with
 * `/vid`; this file is only the table of what those keys mean for pictures.
 */
import { match } from 'ts-pattern';
import type { GenerationOptionValue } from '../../services/comfy-forward-service.js';
import {
    asInteger,
    asNumber,
    asSize,
    badFlag,
    isAddressedToUs,
    oneOption,
    scanLeadingFlags,
    splitNegativePrompt,
    type FlagResult,
} from './command-flags.js';

export interface PicCommandSpec {
    /** What the user asked for with `-w=`; matched against workflow ids later */
    workflowQuery: string | null;
    options: Record<string, GenerationOptionValue>;
    prompt: string;
    negativePrompt: string | null;
    /** `-!:` — replaces the backend's built-in negatives (Z-Image only) */
    negativePromptOverride: boolean;
    /** `/pic` masks the result, `/picunsafe` doesn't */
    spoiler: boolean;
}

export type PicCommandParse =
    /** Not one of our pic commands */
    | { type: 'none' }
    /** Malformed parameters, or nothing to generate from → show the help */
    | { type: 'invalid'; reason: string }
    | { type: 'valid'; spec: PicCommandSpec };

/**
 * `picunsafe` comes first: regex alternation is ordered, and with `pic` first
 * `/picunsafe` would match `pic` and then fail the `(?=\s|$)` lookahead.
 * That same lookahead is what keeps `/picbanana` and `/picgpt` out of here.
 */
const COMMAND_PATTERN = /^\/(picunsafe|pic)(?:@(\S+))?(?=\s|$)\s*([\s\S]*)$/;

/** Bare prefix test, for callers that only need "is this a pic command?" */
export const isPicCommandText = (rawText: string | undefined): boolean =>
    parsePicCommand(rawText).type !== 'none';

/** Turn one `-key=value` into request fields, or explain why it can't be */
const parseFlag = (key: string, raw: string): FlagResult =>
    match(key.toLowerCase())
        .with('w', () => ({ ok: true as const, entries: [], meta: { w: raw } }))
        .with('seed', () =>
            oneOption(key, raw, 'seed', asInteger(raw, 0, Number.MAX_SAFE_INTEGER), '要是 0 以上的整数'))
        .with('steps', () => oneOption(key, raw, 'steps', asInteger(raw, 1, 100), '要是 1-100 的整数'))
        .with('cfg', () => oneOption(key, raw, 'cfg', asNumber(raw, 0, 100), '要是 0-100 的数'))
        .with('n', () => oneOption(key, raw, 'batch_size', asInteger(raw, 1, 8), '要是 1-8 的整数'))
        .with('mp', () => oneOption(key, raw, 'megapixels', asNumber(raw, 0.1, 4), '要是 0.1-4 的数'))
        .with('sampler', () => oneOption(key, raw, 'sampler_name', raw, ''))
        .with('scheduler', () => oneOption(key, raw, 'scheduler', raw, ''))
        .with('size', () => {
            const entries = asSize(raw);
            return entries === null
                ? badFlag(key, raw, '要写成 `-size=1024x1024`，长宽都在 64-4096 之间')
                : { ok: true as const, entries };
        })
        .with('ar', () =>
            match(raw.toLowerCase())
                .with('auto', 'input', 'landscape', (mode) => ({
                    ok: true as const,
                    entries: [['aspect_mode', mode] as const],
                }))
                .otherwise(() => badFlag(key, raw, '只能是 auto / input / landscape'))
        )
        .otherwise(() => ({
            ok: false as const,
            reason: `不认识的参数 \`-${key}=\``,
        }));

/**
 * Parse a pic command out of a message's text or caption.
 *
 * An empty prompt is NOT rejected here: with a reference image, "just re-render
 * this" is a legitimate request, and only the caller knows whether one exists.
 */
export const parsePicCommand = (rawText: string | undefined): PicCommandParse => {
    const matched = rawText?.match(COMMAND_PATTERN);
    if (!matched) return { type: 'none' };

    const [, command, mention, args = ''] = matched;
    if (!isAddressedToUs(mention)) return { type: 'none' };

    const { body, negativePrompt, negativePromptOverride } = splitNegativePrompt(args);
    const { options, meta, rest, reason } = scanLeadingFlags(body, parseFlag);
    if (reason) return { type: 'invalid', reason };

    return {
        type: 'valid',
        spec: {
            workflowQuery: meta.w ?? null,
            options,
            prompt: rest.trim(),
            negativePrompt,
            negativePromptOverride,
            spoiler: command === 'pic',
        },
    };
};
