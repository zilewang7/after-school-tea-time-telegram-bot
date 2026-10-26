/**
 * generate_image arguments, checked against the declared schema.
 *
 * Every problem is reported at once, in words the model can fix its call
 * with. Optional fields sent as null count as absent: models fill unused
 * optional fields that way.
 */
import { isJsonObject } from '../../shared/json-object.js';

export const IMAGE_ASPECT_RATIOS = [
    '1:1',
    '2:3',
    '3:2',
    '3:4',
    '4:3',
    '4:5',
    '5:4',
    '9:16',
    '16:9',
    '21:9',
] as const;

export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

export interface ImageReferenceArg {
    /** `#N` of the message holding the image */
    readonly message: number;
    /** 1-based image within that message; undefined = all of them */
    readonly image: number | undefined;
}

/** A picture outside the messages: a search candidate, an already-read image, or a pack sticker */
export interface ImageWebReferenceArg {
    readonly searchId: string | undefined;
    readonly imageId: string | undefined;
    readonly sticker: string | undefined;
}

export interface GenerateImageArgs {
    readonly prompt: string;
    /** Empty: the image goes out without a caption */
    readonly caption: string;
    /** Empty: drawn from scratch */
    readonly references: readonly ImageReferenceArg[];
    /** Web pictures to follow, resolved by the tool from the reply's media state */
    readonly webReferences: readonly ImageWebReferenceArg[];
    readonly aspectRatio: ImageAspectRatio | undefined;
}

export type ParsedImageArgs =
    | { readonly ok: true; readonly args: GenerateImageArgs }
    | { readonly ok: false; readonly error: string };

type Field<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problems: readonly string[] };

const valid = <T>(value: T): Field<T> => ({ ok: true, value });
const invalid = <T>(problem: string): Field<T> => ({ ok: false, problems: [problem] });

const isAbsent = (value: unknown): value is null | undefined => value === undefined || value === null;

const isPositiveInteger = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1;

const isAspectRatio = (value: unknown): value is ImageAspectRatio =>
    IMAGE_ASPECT_RATIOS.some((ratio) => ratio === value);

const parsePrompt = (value: unknown): Field<string> =>
    typeof value === 'string' && value.trim()
        ? valid(value.trim())
        : invalid('prompt 必须是非空字符串');

const parseCaption = (value: unknown): Field<string> =>
    typeof value === 'string'
        ? valid(value.trim())
        : invalid('caption 必须是字符串（不需要配文就传空字符串）');

const parseReference = (value: unknown, label: string): Field<ImageReferenceArg> => {
    if (!isJsonObject(value)) return invalid(`${label} 必须是 {"message": 编号} 这样的对象`);

    const { message, image } = value;
    if (!isPositiveInteger(message)) return invalid(`${label}.message 必须是正整数（#N 里的数字）`);
    if (isAbsent(image)) return valid({ message, image: undefined });
    if (!isPositiveInteger(image)) return invalid(`${label}.image 必须是从 1 开始的正整数`);
    return valid({ message, image });
};

const parseReferences = (value: unknown): Field<readonly ImageReferenceArg[]> => {
    if (isAbsent(value)) return valid([]);
    if (!Array.isArray(value)) return invalid('references 必须是数组，例如 [{"message": 3}]');

    const parsed = value.map((item: unknown, index) => parseReference(item, `references[${index}]`));
    const problems = parsed.flatMap((item) => (item.ok ? [] : item.problems));
    if (problems.length > 0) return { ok: false, problems };
    return valid(parsed.flatMap((item) => (item.ok ? [item.value] : [])));
};

/** One extra reference: exactly one of search_id / image_id / sticker */
const parseWebReference = (value: unknown, label: string): Field<ImageWebReferenceArg> => {
    if (!isJsonObject(value)) {
        return invalid(
            `${label} 必须是 {"search_id": "s2"}、{"image_id": "img1"} 或 {"sticker": "st1"} 这样的对象`
        );
    }

    const searchId = isAbsent(value.search_id) ? '' : value.search_id;
    const imageId = isAbsent(value.image_id) ? '' : value.image_id;
    const sticker = isAbsent(value.sticker) ? '' : value.sticker;
    if (typeof searchId !== 'string' || typeof imageId !== 'string' || typeof sticker !== 'string') {
        return invalid(`${label} 的 search_id / image_id / sticker 必须是字符串`);
    }
    const given = [searchId.trim(), imageId.trim(), sticker.trim()].filter((id) => id !== '');
    if (given.length !== 1) {
        return invalid(`${label} 的 search_id、image_id 和 sticker 必须传且只传一个`);
    }
    return valid({
        searchId: searchId.trim() === '' ? undefined : searchId.trim(),
        imageId: imageId.trim() === '' ? undefined : imageId.trim(),
        sticker: sticker.trim() === '' ? undefined : sticker.trim(),
    });
};

const parseWebReferences = (value: unknown): Field<readonly ImageWebReferenceArg[]> => {
    if (isAbsent(value)) return valid([]);
    if (!Array.isArray(value)) return invalid('web_references 必须是数组，例如 [{"search_id": "s2"}]');

    const parsed = value.map((item: unknown, index) => parseWebReference(item, `web_references[${index}]`));
    const problems = parsed.flatMap((item) => (item.ok ? [] : item.problems));
    if (problems.length > 0) return { ok: false, problems };
    return valid(parsed.flatMap((item) => (item.ok ? [item.value] : [])));
};

const parseAspectRatio = (value: unknown): Field<ImageAspectRatio | undefined> => {
    if (isAbsent(value)) return valid(undefined);
    return isAspectRatio(value)
        ? valid(value)
        : invalid(`aspect_ratio 只能是 ${IMAGE_ASPECT_RATIOS.join('、')} 之一`);
};

export const parseGenerateImageArgs = (args: Readonly<Record<string, unknown>>): ParsedImageArgs => {
    const prompt = parsePrompt(args.prompt);
    const caption = parseCaption(args.caption);
    const references = parseReferences(args.references);
    const webReferences = parseWebReferences(args.web_references);
    const aspectRatio = parseAspectRatio(args.aspect_ratio);

    if (prompt.ok && caption.ok && references.ok && webReferences.ok && aspectRatio.ok) {
        return {
            ok: true,
            args: {
                prompt: prompt.value,
                caption: caption.value,
                references: references.value,
                webReferences: webReferences.value,
                aspectRatio: aspectRatio.value,
            },
        };
    }

    const problems = [prompt, caption, references, webReferences, aspectRatio].flatMap((field) =>
        field.ok ? [] : field.problems
    );
    return { ok: false, error: `参数有误：\n${problems.map((problem) => `- ${problem}`).join('\n')}` };
};
