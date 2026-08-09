/**
 * The `-key=value` grammar the generation commands share.
 *
 * Flags are only recognised at the HEAD of the argument list — scanning stops
 * at the first token that isn't `-key=value`. Prompts are free text and
 * regularly contain hyphens, so a trailing-flag syntax would either eat prompt
 * words or need quoting; neither is worth it.
 *
 * Each command supplies its own `parseFlag`, because the same letters mean
 * different things: `-ar` is FLUX.2's aspect MODE for `/pic` and H3's aspect
 * RATIO for `/vid`. Only the scanning is common.
 */
import type { GenerationOptionValue } from '../../services/comfy-forward-service.js';

/** One leading parameter, e.g. `-steps=20` */
export const FLAG_PATTERN = /^-([a-zA-Z]+)=(\S+)$/;

export type FlagEntry = readonly [string, GenerationOptionValue];

export type FlagResult =
    /** `entries` land in `options`; `meta` holds anything not sent to the API */
    | { ok: true; entries: FlagEntry[]; meta?: Record<string, string> }
    | { ok: false; reason: string };

/**
 * A command explicitly addressed to another bot is not ours to answer — with
 * privacy mode off we receive those too.
 */
export const isAddressedToUs = (mention: string | undefined): boolean => {
    if (!mention) return true;
    const ownUserName = process.env.BOT_USER_NAME;
    if (!ownUserName) return true; // unconfigured: keep answering as before
    return mention.toLowerCase() === ownUserName.toLowerCase();
};

export const asInteger = (raw: string, min: number, max: number): number | null => {
    if (!/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return value >= min && value <= max ? value : null;
};

export const asNumber = (raw: string, min: number, max: number): number | null => {
    if (!/^\d+(\.\d+)?$/.test(raw)) return null;
    const value = Number(raw);
    return value >= min && value <= max ? value : null;
};

export const asBoolean = (raw: string): boolean | null =>
    ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())
        ? true
        : ['0', 'false', 'no', 'off'].includes(raw.toLowerCase())
            ? false
            : null;

/** `1344x768` → width/height. `multipleOf` is H3's 32-pixel grid. */
export const asSize = (raw: string, multipleOf = 1): FlagEntry[] | null => {
    const matched = raw.match(/^(\d+)[x×](\d+)$/);
    if (!matched) return null;
    const width = asInteger(matched[1]!, 64, 4096);
    const height = asInteger(matched[2]!, 64, 4096);
    if (width === null || height === null) return null;
    if (width % multipleOf !== 0 || height % multipleOf !== 0) return null;
    return [['width', width], ['height', height]];
};

export interface NegativeSplit {
    body: string;
    negativePrompt: string | null;
    negativePromptOverride: boolean;
}

/** `-!:` wins over `-:` because it contains it */
export const splitNegativePrompt = (text: string): NegativeSplit => {
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

export interface FlagScan {
    options: Record<string, GenerationOptionValue>;
    /** Flags that steer the bot rather than the API (`-w`, `-mode`, …) */
    meta: Record<string, string>;
    /** Everything from the first non-flag token on: the prompt */
    rest: string;
    /** Set when a flag was malformed; scanning stops there */
    reason?: string;
}

/** Eat `-key=value` tokens off the front, in the order the user wrote them */
export const scanLeadingFlags = (
    body: string,
    parseFlag: (key: string, raw: string) => FlagResult
): FlagScan => {
    const options: Record<string, GenerationOptionValue> = {};
    const meta: Record<string, string> = {};
    let rest = body;

    while (rest.length > 0) {
        const token = rest.split(/\s+/, 1)[0] ?? '';
        const matched = token.match(FLAG_PATTERN);
        if (!matched) break;

        const result = parseFlag(matched[1]!, matched[2]!);
        if (!result.ok) return { options, meta, rest, reason: result.reason };

        result.entries.forEach(([name, value]) => {
            options[name] = value;
        });
        Object.entries(result.meta ?? {}).forEach(([name, value]) => {
            meta[name] = value;
        });

        rest = rest.slice(token.length).trimStart();
    }

    return { options, meta, rest };
};

/** Shared shape of a "one flag was wrong" failure */
export const badFlag = (key: string, raw: string, expected: string): FlagResult => ({
    ok: false,
    reason: `参数 \`-${key}=${raw}\` 不合法，${expected}`,
});

/** Shared shape of "this flag maps to exactly one option" */
export const oneOption = (
    key: string,
    raw: string,
    name: string,
    value: GenerationOptionValue | null,
    expected: string
): FlagResult => (value === null ? badFlag(key, raw, expected) : { ok: true, entries: [[name, value]] });
