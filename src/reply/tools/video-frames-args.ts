/**
 * Arguments of extract_frames, checked against the declared schema.
 *
 * `times` and `count` cannot both be given; `first`/`last` override both. All
 * problems come back at once in words the model can fix its call with.
 */
import { invalid, isAbsent, valid, type Field } from './media-tool-args.js';

/** Frames one call may ask for; the reply-wide cap is enforced by the tool */
export const FRAMES_PER_CALL_MAX = 6;

const FRAME_SIZES = [512, 768, 960, 1280] as const;
export type FrameSize = (typeof FRAME_SIZES)[number];

export interface ExtractFramesArgs {
    readonly message: number;
    readonly mode: 'times' | 'uniform' | 'first' | 'last';
    readonly times?: readonly number[];
    readonly count?: number;
    readonly start?: number;
    readonly end?: number;
    readonly size: FrameSize;
}

export type ParsedExtractFramesArgs =
    | { readonly ok: true; readonly args: ExtractFramesArgs }
    | { readonly ok: false; readonly error: string };

const problemsOf = (fields: ReadonlyArray<Field<unknown>>): string[] =>
    fields.flatMap((field) => (field.ok ? [] : field.problems));

const parseTimes = (value: unknown): Field<readonly number[]> => {
    if (isAbsent(value)) return valid([]);
    if (!Array.isArray(value)) return invalid('times 必须是秒数数组，如 [3.5, 12]');
    if (value.length === 0) return valid([]);
    if (value.length > FRAMES_PER_CALL_MAX) {
        return invalid(`times 最多 ${FRAMES_PER_CALL_MAX} 个（现在 ${value.length} 个）`);
    }
    const times: number[] = [];
    for (const [index, item] of value.entries()) {
        if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) {
            return invalid(`times 第 ${index + 1} 项必须是非负的秒数`);
        }
        times.push(item);
    }
    return valid(times);
};

const parseCount = (value: unknown): Field<number | undefined> => {
    if (isAbsent(value)) return valid(undefined);
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > FRAMES_PER_CALL_MAX) {
        return invalid(`count 必须是 1-${FRAMES_PER_CALL_MAX} 的整数`);
    }
    return valid(value);
};

const parseOptionalSeconds = (value: unknown, label: string): Field<number | undefined> => {
    if (isAbsent(value)) return valid(undefined);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return invalid(`${label} 必须是非负的秒数`);
    }
    return valid(value);
};

export const parseExtractFramesArgs = (
    args: Readonly<Record<string, unknown>>
): ParsedExtractFramesArgs => {
    const rawMessage = args.message;
    const message: Field<number> =
        typeof rawMessage === 'number' && Number.isInteger(rawMessage) && rawMessage >= 1
            ? valid(rawMessage)
            : invalid('message 要写上下文里的消息编号（#N 里的数字，如 12）');

    const times = parseTimes(args.times);
    const count = parseCount(args.count);

    const rawMode = args.mode;
    const mode: Field<'times' | 'uniform' | 'first' | 'last' | undefined> = isAbsent(rawMode)
        ? valid(undefined)
        : rawMode === 'times' || rawMode === 'uniform' || rawMode === 'first' || rawMode === 'last'
          ? valid(rawMode)
          : invalid("mode 只能是 'times'、'uniform'、'first' 或 'last'");

    const start = parseOptionalSeconds(args.start, 'start');
    const end = parseOptionalSeconds(args.end, 'end');

    const rawSize = args.size;
    const size: Field<FrameSize> = isAbsent(rawSize)
        ? valid(960)
        : rawSize === 512 || rawSize === 768 || rawSize === 960 || rawSize === 1280
          ? valid(rawSize)
          : invalid(`size 只能是 ${FRAME_SIZES.join('/')} 之一`);

    const problems = problemsOf([message, times, count, mode, start, end, size]);
    if (problems.length > 0) {
        return { ok: false, error: `参数有误：\n${problems.map((problem) => `- ${problem}`).join('\n')}` };
    }
    if (
        !message.ok
        || !times.ok
        || !count.ok
        || !mode.ok
        || !start.ok
        || !end.ok
        || !size.ok
    ) {
        return { ok: false, error: '参数有误' };
    }

    const timesValue = times.value;
    const countValue = count.value;
    if (timesValue.length > 0 && countValue !== undefined) {
        return { ok: false, error: '参数有误：\n- times 与 count 只能给一个' };
    }
    if (start.value !== undefined && end.value !== undefined && end.value <= start.value) {
        return { ok: false, error: '参数有误：\n- end 必须大于 start' };
    }
    const explicitMode = mode.value;
    if (explicitMode === 'times' && timesValue.length === 0) {
        return { ok: false, error: '参数有误：\n- mode=\'times\' 需要同时给 times' };
    }
    const resolvedMode: ExtractFramesArgs['mode'] =
        explicitMode === 'first' || explicitMode === 'last'
            ? explicitMode
            : timesValue.length > 0
              ? 'times'
              : 'uniform';
    if (resolvedMode === 'uniform' && countValue === undefined && timesValue.length === 0) {
        // no count and no times: even sampling with the default is the useful answer
        return {
            ok: true,
            args: {
                message: message.value,
                mode: 'uniform',
                ...(start.value === undefined ? {} : { start: start.value }),
                ...(end.value === undefined ? {} : { end: end.value }),
                size: size.value,
            },
        };
    }
    return {
        ok: true,
        args: {
            message: message.value,
            mode: resolvedMode,
            ...(timesValue.length === 0 ? {} : { times: timesValue }),
            ...(countValue === undefined ? {} : { count: countValue }),
            ...(start.value === undefined ? {} : { start: start.value }),
            ...(end.value === undefined ? {} : { end: end.value }),
            size: size.value,
        },
    };
};
