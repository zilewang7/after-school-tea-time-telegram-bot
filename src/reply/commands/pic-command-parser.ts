/**
 * `/pic` and `/picunsafe` syntax, parsed in one place.
 *
 * Shape: `/pic [-key=value ...] <prompt> [-: negative | -!: negative]`
 *
 * Flags are only recognised at the HEAD of the argument list — parsing stops at
 * the first token that isn't `-key=value`. Prompts are free text and regularly
 * contain hyphens, so a trailing-flag syntax would either eat prompt words or
 * need quoting; neither is worth it.
 */
import { match } from 'ts-pattern';
import type { GenerationOptionValue } from '../../services/comfy-forward-service.js';

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

/** One leading parameter, e.g. `-steps=20` */
const FLAG_PATTERN = /^-([a-zA-Z]+)=(\S+)$/;

/**
 * A command explicitly addressed to another bot is not ours to answer — same
 * rule as `/chat`, since with privacy mode off we receive those too.
 */
const isAddressedToUs = (mention: string | undefined): boolean => {
    if (!mention) return true;
    const ownUserName = process.env.BOT_USER_NAME;
    if (!ownUserName) return true; // unconfigured: keep answering as before
    return mention.toLowerCase() === ownUserName.toLowerCase();
};

/** Bare prefix test, for callers that only need "is this a pic command?" */
export const isPicCommandText = (rawText: string | undefined): boolean =>
    parsePicCommand(rawText).type !== 'none';

interface NegativeSplit {
    body: string;
    negativePrompt: string | null;
    negativePromptOverride: boolean;
}

/** `-!:` wins over `-:` because it contains it */
const splitNegativePrompt = (text: string): NegativeSplit => {
    for (const [marker, override] of [['-!:', true], ['-:', false]] as const) {
        const at = text.indexOf(marker);
        if (at === -1) continue;
        return {
            body: text.slice(0, at).trim(),
            negativePrompt: text.slice(at + marker.length).trim() || null,
            negativePromptOverride: override,
        };
    }
    return { body: text.trim(), negativePrompt: null, negativePromptOverride: false };
};

type OptionEntry = readonly [string, GenerationOptionValue];

type FlagResult =
    | { ok: true; entries: OptionEntry[]; workflowQuery?: string }
    | { ok: false; reason: string };

const asInteger = (raw: string, min: number, max: number): number | null => {
    if (!/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return value >= min && value <= max ? value : null;
};

const asNumber = (raw: string, min: number, max: number): number | null => {
    if (!/^\d+(\.\d+)?$/.test(raw)) return null;
    const value = Number(raw);
    return value >= min && value <= max ? value : null;
};

/** `1344x768` → width/height */
const asSize = (raw: string): OptionEntry[] | null => {
    const matched = raw.match(/^(\d+)[x×](\d+)$/);
    if (!matched) return null;
    const width = asInteger(matched[1]!, 64, 4096);
    const height = asInteger(matched[2]!, 64, 4096);
    if (width === null || height === null) return null;
    return [['width', width], ['height', height]];
};

/** Turn one `-key=value` into request fields, or explain why it can't be */
const parseFlag = (key: string, raw: string): FlagResult => {
    const bad = (expected: string): FlagResult => ({
        ok: false,
        reason: `参数 \`-${key}=${raw}\` 不合法，${expected}`,
    });
    const one = (name: string, value: GenerationOptionValue | null, expected: string): FlagResult =>
        value === null ? bad(expected) : { ok: true, entries: [[name, value]] };

    return match(key.toLowerCase())
        .with('w', () => ({ ok: true as const, entries: [], workflowQuery: raw }))
        .with('seed', () => one('seed', asInteger(raw, 0, Number.MAX_SAFE_INTEGER), '要是 0 以上的整数'))
        .with('steps', () => one('steps', asInteger(raw, 1, 100), '要是 1-100 的整数'))
        .with('cfg', () => one('cfg', asNumber(raw, 0, 100), '要是 0-100 的数'))
        .with('n', () => one('batch_size', asInteger(raw, 1, 8), '要是 1-8 的整数'))
        .with('mp', () => one('megapixels', asNumber(raw, 0.1, 4), '要是 0.1-4 的数'))
        .with('sampler', () => one('sampler_name', raw, ''))
        .with('scheduler', () => one('scheduler', raw, ''))
        .with('size', () => {
            const entries = asSize(raw);
            return entries === null
                ? bad('要写成 `-size=1024x1024`，长宽都在 64-4096 之间')
                : { ok: true as const, entries };
        })
        .with('ar', () =>
            match(raw.toLowerCase())
                .with('auto', 'input', 'landscape', (mode) => ({
                    ok: true as const,
                    entries: [['aspect_mode', mode] satisfies OptionEntry],
                }))
                .otherwise(() => bad('只能是 auto / input / landscape'))
        )
        .otherwise(() => ({
            ok: false as const,
            reason: `不认识的参数 \`-${key}=\``,
        }));
};

interface FlagScan {
    workflowQuery: string | null;
    options: Record<string, GenerationOptionValue>;
    rest: string;
    reason?: string;
}

/** Eat `-key=value` tokens off the front; everything from the first non-flag on is the prompt */
const scanFlags = (body: string): FlagScan => {
    const options: Record<string, GenerationOptionValue> = {};
    let workflowQuery: string | null = null;
    let rest = body;

    while (rest.length > 0) {
        const token = rest.split(/\s+/, 1)[0] ?? '';
        const matched = token.match(FLAG_PATTERN);
        if (!matched) break;

        const result = parseFlag(matched[1]!, matched[2]!);
        if (!result.ok) return { workflowQuery, options, rest, reason: result.reason };

        result.entries.forEach(([name, value]) => {
            options[name] = value;
        });
        if (result.workflowQuery !== undefined) workflowQuery = result.workflowQuery;

        rest = rest.slice(token.length).trimStart();
    }

    return { workflowQuery, options, rest };
};

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
    const { workflowQuery, options, rest, reason } = scanFlags(body);
    if (reason) return { type: 'invalid', reason };

    return {
        type: 'valid',
        spec: {
            workflowQuery,
            options,
            prompt: rest.trim(),
            negativePrompt,
            negativePromptOverride,
            spoiler: command === 'pic',
        },
    };
};
