/**
 * The `-key=value` grammar the generation commands share.
 *
 * A flag is recognised ANYWHERE in the argument list, not just at the head:
 * `/vid 雨夜的街头 -ar=9:16` is what people actually type, and the earlier
 * head-only rule silently swallowed such a flag into the prompt — the request
 * then went out with the default ratio and nothing said so.
 *
 * Free text is protected by only ever consuming keys the command knows. An
 * unrecognised `-foo=bar` is an error while it is still among the leading
 * flags (a typo'd parameter), but plain prompt text once the prompt has begun.
 *
 * Each command supplies its own `parseFlag`, because the same letters mean
 * different things: `-ar` is FLUX.2's aspect MODE for `/pic` and H3's aspect
 * RATIO for `/vid`. Only the scanning is common.
 */
import type { GenerationOptionValue } from '../../services/comfy-forward-service.js';

/** One parameter, e.g. `-steps=20`; `=value` is optional so a bare `-steps` is caught */
export const FLAG_PATTERN = /(^|\s)-([a-zA-Z]+)(?:=(\S+))?(?=\s|$)/g;

export type FlagEntry = readonly [string, GenerationOptionValue];

export type FlagResult =
    /** `entries` land in `options`; `meta` holds anything not sent to the API */
    | { ok: true; entries: FlagEntry[]; meta?: Record<string, string> }
    /** `unknownKey` separates "not a parameter at all" from "bad value" */
    | { ok: false; reason: string; unknownKey?: true };

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
    /** Everything that wasn't a flag: the prompt, with its line breaks intact */
    rest: string;
    /** Set when a flag was malformed; scanning stops there */
    reason?: string;
}

/**
 * Does this command know the key at all? Probed with an empty value, so a known
 * key answers "bad value" (or even accepts it) while an unknown one says so.
 */
const knowsKey = (parseFlag: (key: string, raw: string) => FlagResult, key: string): boolean => {
    const probe = parseFlag(key, '');
    return probe.ok || probe.unknownKey !== true;
};

/** Pull every `-key=value` this command understands out of the argument text */
export const scanFlags = (
    body: string,
    parseFlag: (key: string, raw: string) => FlagResult
): FlagScan => {
    const options: Record<string, GenerationOptionValue> = {};
    const meta: Record<string, string> = {};

    // Rebuilt from the pieces between the flags, so a multi-line prompt keeps
    // its shape instead of being re-joined by single spaces
    let kept = '';
    let cursor = 0;
    let promptStarted = false;

    for (const matched of body.matchAll(FLAG_PATTERN)) {
        const [whole, lead = '', key = '', value] = matched;
        const start = matched.index + lead.length;
        const before = body.slice(cursor, start);
        if (before.trim().length > 0) promptStarted = true;

        if (value === undefined) {
            // A hyphen word inside a prompt is ordinary text; a known key
            // written without its value is a mistake worth naming
            if (!knowsKey(parseFlag, key)) continue;
            return {
                options,
                meta,
                rest: (kept + body.slice(cursor)).trim(),
                reason: `参数 \`-${key}\` 少了值，要写成 \`-${key}=…\`，等号两边不能有空格`,
            };
        }

        const result = parseFlag(key, value);
        if (!result.ok) {
            // Unknown keys are only a typo while the prompt hasn't started;
            // after that they are just words the user wrote
            if (result.unknownKey === true && promptStarted) continue;
            return { options, meta, rest: (kept + body.slice(cursor)).trim(), reason: result.reason };
        }

        result.entries.forEach(([name, entryValue]) => {
            options[name] = entryValue;
        });
        Object.entries(result.meta ?? {}).forEach(([name, metaValue]) => {
            meta[name] = metaValue;
        });

        kept += before;
        cursor = start + whole.length - lead.length;

        // Lifting a flag out of the middle of a sentence would otherwise leave
        // the spaces from both of its sides behind
        if (/\s$/.test(before)) {
            const spaces = body.slice(cursor).match(/^[^\S\n]+/);
            if (spaces) cursor += spaces[0].length;
        }
    }

    return { options, meta, rest: (kept + body.slice(cursor)).trim() };
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
