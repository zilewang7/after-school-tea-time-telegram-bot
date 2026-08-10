/**
 * `/vid` and `/vidunsafe` syntax.
 *
 * Shape: `/vid [-key=value ...] <idea>`
 *
 * The idea is deliberately NOT the prompt: unless `-raw=1` says otherwise it is
 * a rough brief that Grok expands into an H3 storyboard (see h3-prompt-service).
 * So there is no `-:` negative prompt here — H3 doesn't take one — and the two
 * flags that matter most (`-w`, `-mode`) steer the bot rather than the API.
 */
import { match } from 'ts-pattern';
import type { GenerationOptionValue } from '../../services/comfy-forward-service.js';
import { parseAspectRatio } from './aspect-ratio.js';
import {
    asBoolean,
    asInteger,
    asNumber,
    asSize,
    badFlag,
    isAddressedToUs,
    oneOption,
    scanFlags,
    splitNegativePrompt,
    type FlagResult,
} from './command-flags.js';

/**
 * How the reference material constrains the video — H3's conditioning axis,
 * orthogonal to the sampling scheme (Turbo/Base) that `-w=` picks. `auto` is
 * resolved once the workflow and the images are both known.
 *
 * `l2va` (a last frame with no first frame) is deliberately absent: the API
 * requires `last_frame` to come with a `first_frame`, so there is no way to
 * submit one.
 */
export type VidMode = 'auto' | 't2va' | 'i2va' | 'fl2va' | 'ref2va';

const VID_MODES: VidMode[] = ['auto', 't2va', 'i2va', 'fl2va', 'ref2va'];

/** H3 requires width and height to be multiples of 32 */
const SIZE_GRID = 32;

export interface VidCommandSpec {
    /** What the user asked for with `-w=`; matched against workflow ids later */
    workflowQuery: string | null;
    options: Record<string, GenerationOptionValue>;
    /** The user's idea, in whatever language they wrote it */
    brief: string;
    mode: VidMode;
    /** `-shots=`: passed to the storyboard writer, never to the API */
    shots: number | null;
    /** `-raw=1`: the brief already IS an H3 prompt, skip the storyboard step */
    raw: boolean;
    /** `/vid` masks the result, `/vidunsafe` doesn't */
    spoiler: boolean;
    /** The user wrote `-:` — H3 has no negative prompt, so say so once */
    negativeIgnored: boolean;
}

export type VidCommandParse =
    | { type: 'none' }
    | { type: 'invalid'; reason: string }
    | { type: 'valid'; spec: VidCommandSpec };

/** `vidunsafe` first, for the same reason `picunsafe` is (ordered alternation) */
const COMMAND_PATTERN = /^\/(vidunsafe|vid)(?:@(\S+))?(?=\s|$)\s*([\s\S]*)$/;

export const isVidCommandText = (rawText: string | undefined): boolean =>
    parseVidCommand(rawText).type !== 'none';

const parseFlag = (key: string, raw: string): FlagResult =>
    match(key.toLowerCase())
        .with('w', () => ({ ok: true as const, entries: [], meta: { w: raw } }))
        .with('mode', () => {
            const lowered = raw.toLowerCase();
            return VID_MODES.some((mode) => mode === lowered)
                ? { ok: true as const, entries: [], meta: { mode: lowered } }
                : badFlag(key, raw, `只能是 ${VID_MODES.join(' / ')}`);
        })
        .with('raw', () => {
            const value = asBoolean(raw);
            return value === null
                ? badFlag(key, raw, '要写成 `-raw=1`')
                : { ok: true as const, entries: [], meta: { raw: value ? '1' : '0' } };
        })
        .with('shots', () => {
            const value = asInteger(raw, 1, 5);
            return value === null
                ? badFlag(key, raw, '要是 1-5 的整数')
                : { ok: true as const, entries: [], meta: { shots: String(value) } };
        })
        .with('d', 'dur', () =>
            oneOption(key, raw, 'duration_seconds', asInteger(raw, 1, 15), '要是 1-15 秒'))
        .with('seed', () =>
            oneOption(key, raw, 'seed', asInteger(raw, 0, Number.MAX_SAFE_INTEGER), '要是 0 以上的整数'))
        // Not clamped to H3 Turbo's 4-8 here: a Base workflow wants ~24, and
        // the builder is the one that knows which workflow was picked
        .with('steps', () => oneOption(key, raw, 'steps', asInteger(raw, 1, 100), '要是 1-100 的整数'))
        .with('mp', () => oneOption(key, raw, 'megapixels', asNumber(raw, 0.1, 4), '要是 0.1-4 的数'))
        .with('lora', () => oneOption(key, raw, 'lora_strength', asNumber(raw, 0, 2), '要是 0-2 的数'))
        // Base only; Turbo's sampler is fixed by its LoRA
        .with('sampler', () => oneOption(key, raw, 'sampler_name', raw, ''))
        .with('ref', () =>
            match(raw.toLowerCase())
                .with('match', 'max', (size) => ({
                    ok: true as const,
                    entries: [['ref_image_size', size] as const],
                }))
                .otherwise(() => badFlag(key, raw, '只能是 match / max'))
        )
        .with('lowvram', () => {
            const value = asBoolean(raw);
            return value === null
                ? badFlag(key, raw, '要写成 `-lowvram=1`')
                : { ok: true as const, entries: [['low_vram', value] as const] };
        })
        // Any 宽:高 the server accepts, not a fixed list (API 2.3.1)
        .with('ar', () => {
            const ratio = parseAspectRatio(raw);
            return ratio === null
                ? badFlag(key, raw, '要写成 `宽:高`，比例在 1:4 到 4:1 之间，例如 `9:16` `5:4` `2.39:1`')
                : { ok: true as const, entries: [['aspect_ratio', ratio.text] as const] };
        })
        .with('size', () => {
            const entries = asSize(raw, SIZE_GRID);
            return entries === null
                ? badFlag(key, raw, '要写成 `-size=608x352`，长宽在 64-4096 之间且都是 32 的倍数')
                : { ok: true as const, entries };
        })
        .otherwise(() => ({
            ok: false as const,
            unknownKey: true as const,
            reason: `不认识的参数 \`-${key}=\``,
        }));

export const parseVidCommand = (rawText: string | undefined): VidCommandParse => {
    const matched = rawText?.match(COMMAND_PATTERN);
    if (!matched) return { type: 'none' };

    const [, command, mention, args = ''] = matched;
    if (!isAddressedToUs(mention)) return { type: 'none' };

    // H3 ignores negative prompts, but people will write them out of `/pic`
    // habit — strip them off the brief so they don't end up as scene direction
    const { body, negativePrompt } = splitNegativePrompt(args);
    const { options, meta, rest, reason } = scanFlags(body, parseFlag);
    if (reason) return { type: 'invalid', reason };

    const mode = VID_MODES.find((candidate) => candidate === meta.mode) ?? 'auto';

    return {
        type: 'valid',
        spec: {
            workflowQuery: meta.w ?? null,
            options,
            brief: rest.trim(),
            mode,
            shots: meta.shots === undefined ? null : Number(meta.shots),
            raw: meta.raw === '1',
            spoiler: command === 'vid',
            negativeIgnored: negativePrompt !== null,
        },
    };
};
