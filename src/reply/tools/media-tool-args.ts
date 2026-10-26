/**
 * Arguments of the media tools, checked against their declared schemas.
 *
 * Every problem comes back at once, in words the model can fix its call with.
 * Optional fields sent as null count as absent: models fill unused optional
 * fields that way.
 */
import { MAX_SEARCH_CANDIDATES } from './reply-media-state.js';

export type Field<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly problems: readonly string[] };

export const valid = <T>(value: T): Field<T> => ({ ok: true, value });
export const invalid = <T>(problem: string): Field<T> => ({ ok: false, problems: [problem] });

export const isAbsent = (value: unknown): value is null | undefined =>
    value === undefined || value === null;

export const isPositiveInteger = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1;

const isHttpUrl = (value: string): boolean => {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
};

const problemsOf = (fields: ReadonlyArray<Field<unknown>>): string[] =>
    fields.flatMap((field) => (field.ok ? [] : field.problems));

/** `s1` / `q2` / `img3`, the ids the tools hand out */
const idPattern = /^[a-z]{1,3}\d+$/;

/** A string field: trimmed, length-capped, empty when it was blank */
const parseOptionalText = (value: unknown, label: string, maxChars: number): Field<string> => {
    if (isAbsent(value)) return valid('');
    if (typeof value !== 'string') return invalid(`${label} 必须是字符串`);
    const text = value.trim();
    if (Array.from(text).length > maxChars) return invalid(`${label} 太长（最多 ${maxChars} 字）`);
    return valid(text);
};

export interface SearchImagesArgs {
    /** A new search; absent when paging an existing set */
    readonly query: string | undefined;
    readonly searchId: string | undefined;
    readonly count: number;
    readonly view: 'thumbnails' | 'details';
}

export type ParsedSearchArgs =
    | { readonly ok: true; readonly args: SearchImagesArgs }
    | { readonly ok: false; readonly error: string };

const parseCount = (value: unknown): Field<number> => {
    if (isAbsent(value)) return valid(MAX_SEARCH_CANDIDATES);
    if (!isPositiveInteger(value) || value > MAX_SEARCH_CANDIDATES) {
        return invalid(`count 必须是 1–${MAX_SEARCH_CANDIDATES} 的整数（省略就是 ${MAX_SEARCH_CANDIDATES}）`);
    }
    return valid(value);
};

const parseSearchView = (value: unknown): Field<'thumbnails' | 'details'> => {
    if (isAbsent(value)) return valid('thumbnails');
    if (value === 'thumbnails' || value === 'details') return valid(value);
    return invalid("view 只能是 'thumbnails'（看图，默认）或 'details'（只看文字清单）");
};

export const parseSearchImagesArgs = (
    args: Readonly<Record<string, unknown>>
): ParsedSearchArgs => {
    const query = parseOptionalText(args.query, 'query', 200);
    const search = parseOptionalText(args.search, 'search', 16);
    const count = parseCount(args.count);
    const view = parseSearchView(args.view);

    const problems = problemsOf([query, search, count, view]);
    if (problems.length > 0) return { ok: false, error: `参数有误：\n${problems.map((p) => `- ${p}`).join('\n')}` };

    const queryText = query.ok ? query.value : '';
    const searchId = search.ok ? search.value : '';
    if (queryText === '' && searchId === '') {
        return { ok: false, error: '参数有误：\n- 传 query 开新搜索，或传 search=\'q1\' 在已有结果里继续看' };
    }
    if (queryText !== '' && searchId !== '') {
        return { ok: false, error: "参数有误：\n- query 和 search 只能传一个" };
    }
    if (searchId !== '' && !idPattern.test(searchId)) {
        return { ok: false, error: "参数有误：\n- search 要传搜索集合编号，形如 'q1'" };
    }

    return {
        ok: true,
        args: {
            query: queryText === '' ? undefined : queryText,
            searchId: searchId === '' ? undefined : searchId,
            count: count.ok ? count.value : MAX_SEARCH_CANDIDATES,
            view: view.ok ? view.value : 'thumbnails',
        },
    };
};

export interface FetchImageArgs {
    readonly searchId: string | undefined;
    readonly imageId: string | undefined;
    readonly url: string | undefined;
    readonly view: 'original' | 'thumbnail';
}

export type ParsedFetchArgs =
    | { readonly ok: true; readonly args: FetchImageArgs }
    | { readonly ok: false; readonly error: string };

const parseFetchView = (value: unknown): Field<'original' | 'thumbnail'> => {
    if (isAbsent(value)) return valid('original');
    if (value === 'original' || value === 'thumbnail') return valid(value);
    return invalid("view 只能是 'original'（原图，默认）或 'thumbnail'（缩略图）");
};

const parseUrl = (value: unknown): Field<string> => {
    if (isAbsent(value)) return valid('');
    if (typeof value !== 'string' || !isHttpUrl(value.trim())) {
        return invalid('url 必须是 http(s) 图片直链');
    }
    return valid(value.trim());
};

const countGiven = (values: readonly string[]): number => values.filter((value) => value !== '').length;

export const parseFetchImageArgs = (
    args: Readonly<Record<string, unknown>>
): ParsedFetchArgs => {
    const search = parseOptionalText(args.search_id, 'search_id', 16);
    const image = parseOptionalText(args.image_id, 'image_id', 16);
    const url = parseUrl(args.url);
    const view = parseFetchView(args.view);

    const problems = problemsOf([search, image, url, view]);
    if (problems.length > 0) return { ok: false, error: `参数有误：\n${problems.map((p) => `- ${p}`).join('\n')}` };

    const searchId = search.ok ? search.value : '';
    const imageId = image.ok ? image.value : '';
    const urlText = url.ok ? url.value : '';
    if (countGiven([searchId, imageId, urlText]) !== 1) {
        return { ok: false, error: '参数有误：\n- search_id、image_id、url 必须传且只传一个' };
    }
    if ((searchId !== '' && !idPattern.test(searchId)) || (imageId !== '' && !idPattern.test(imageId))) {
        return { ok: false, error: '参数有误：\n- 编号要形如 s1 或 img1' };
    }

    return {
        ok: true,
        args: {
            searchId: searchId === '' ? undefined : searchId,
            imageId: imageId === '' ? undefined : imageId,
            url: urlText === '' ? undefined : urlText,
            view: view.ok ? view.value : 'original',
        },
    };
};

export interface SendImageArgs {
    readonly searchId: string | undefined;
    readonly imageId: string | undefined;
    readonly message: number | undefined;
    readonly image: number | undefined;
    readonly url: string | undefined;
    readonly caption: string;
}

export type ParsedSendArgs =
    | { readonly ok: true; readonly args: SendImageArgs }
    | { readonly ok: false; readonly error: string };

const parseMessage = (value: unknown): Field<number> => {
    if (isAbsent(value)) return valid(0);
    if (!isPositiveInteger(value)) return invalid('message 必须是从 1 开始的上下文编号（#N 里的数字）');
    return valid(value);
};

const parseImageIndex = (value: unknown): Field<number> => {
    if (isAbsent(value)) return valid(1);
    if (!isPositiveInteger(value)) return invalid('image 必须是从 1 开始的正整数');
    return valid(value);
};

export const parseSendImageArgs = (
    args: Readonly<Record<string, unknown>>
): ParsedSendArgs => {
    const search = parseOptionalText(args.search_id, 'search_id', 16);
    const imageId = parseOptionalText(args.image_id, 'image_id', 16);
    const url = parseUrl(args.url);
    const message = parseMessage(args.message);
    const image = parseImageIndex(args.image);
    const caption = parseOptionalText(args.caption, 'caption', 1000);

    const problems = problemsOf([search, imageId, url, message, image, caption]);
    if (problems.length > 0) return { ok: false, error: `参数有误：\n${problems.map((p) => `- ${p}`).join('\n')}` };

    const searchId = search.ok ? search.value : '';
    const fetchedId = imageId.ok ? imageId.value : '';
    const urlText = url.ok ? url.value : '';
    const messageNumber = message.ok ? message.value : 0;
    if (countGiven([searchId, fetchedId, urlText, messageNumber > 0 ? String(messageNumber) : '']) !== 1) {
        return {
            ok: false,
            error: '参数有误：\n- search_id、image_id、message、url 必须传且只传一个',
        };
    }
    if ((searchId !== '' && !idPattern.test(searchId)) || (fetchedId !== '' && !idPattern.test(fetchedId))) {
        return { ok: false, error: '参数有误：\n- 编号要形如 s1 或 img1' };
    }

    return {
        ok: true,
        args: {
            searchId: searchId === '' ? undefined : searchId,
            imageId: fetchedId === '' ? undefined : fetchedId,
            message: messageNumber > 0 ? messageNumber : undefined,
            image: image.ok ? image.value : 1,
            url: urlText === '' ? undefined : urlText,
            caption: caption.ok ? caption.value : '',
        },
    };
};

export interface SearchByImageArgs {
    readonly message: number | undefined;
    readonly image: number | undefined;
    readonly imageId: string | undefined;
    readonly searchId: string | undefined;
}

export type ParsedSearchByImageArgs =
    | { readonly ok: true; readonly args: SearchByImageArgs }
    | { readonly ok: false; readonly error: string };

/** One picture source, and only one: a context message, a read image or a search candidate */
export const parseSearchByImageArgs = (
    args: Readonly<Record<string, unknown>>
): ParsedSearchByImageArgs => {
    const message = parseMessage(args.message);
    const image = parseImageIndex(args.image);
    const imageId = parseOptionalText(args.image_id, 'image_id', 16);
    const searchId = parseOptionalText(args.search_id, 'search_id', 16);

    const problems = problemsOf([message, image, imageId, searchId]);
    if (problems.length > 0) {
        return { ok: false, error: `参数有误：\n${problems.map((problem) => `- ${problem}`).join('\n')}` };
    }

    const messageNumber = message.ok ? message.value : 0;
    const fetchedId = imageId.ok ? imageId.value : '';
    const searchedId = searchId.ok ? searchId.value : '';
    const sources = [messageNumber > 0, fetchedId !== '', searchedId !== ''].filter(Boolean).length;
    if (sources === 0) {
        return { ok: false, error: '参数有误：\n- 要传 message、image_id 或 search_id 之一' };
    }
    if (sources > 1) {
        return { ok: false, error: '参数有误：\n- message、image_id、search_id 只能传一个' };
    }
    if (!isAbsent(args.image) && messageNumber === 0) {
        return { ok: false, error: '参数有误：\n- image 只能和 message 一起用' };
    }
    if ((fetchedId !== '' && !idPattern.test(fetchedId)) || (searchedId !== '' && !idPattern.test(searchedId))) {
        return { ok: false, error: '参数有误：\n- 编号要形如 s1 或 img1' };
    }

    return {
        ok: true,
        args: {
            message: messageNumber > 0 ? messageNumber : undefined,
            image: messageNumber > 0 && !isAbsent(args.image) && image.ok ? image.value : undefined,
            imageId: fetchedId === '' ? undefined : fetchedId,
            searchId: searchedId === '' ? undefined : searchedId,
        },
    };
};
