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

/** Longest batch one fetch_image call reads */
export const FETCH_BATCH_MAX = 6;

/** One picture source of fetch_image, whichever argument carried it */
export type FetchSource =
    | { readonly kind: 'candidate'; readonly id: string }
    | { readonly kind: 'image'; readonly id: string }
    | { readonly kind: 'url'; readonly url: string }
    | { readonly kind: 'sticker'; readonly query: string }
    | { readonly kind: 'history'; readonly reference: string }
    | { readonly kind: 'avatar'; readonly target: string };

export interface FetchImageArgs {
    /** One source for a single read, 2–6 for a batch */
    readonly sources: readonly FetchSource[];
    /** Values a batch listed twice: read once, said in the result */
    readonly skippedDuplicates: readonly string[];
    /** 1-based position among that message's images */
    readonly image: number;
    readonly view: 'original' | 'thumbnail';
}

export type ParsedFetchArgs =
    | { readonly ok: true; readonly args: FetchImageArgs }
    | { readonly ok: false; readonly error: string };

/** One of the eleven source parameters, as the model wrote it */
interface FetchParam {
    readonly kind: FetchSource['kind'];
    readonly name: string;
    readonly values: readonly string[];
}

const parseFetchTextArray = (value: unknown, label: string, maxChars: number): Field<readonly string[]> => {
    if (isAbsent(value)) return valid([]);
    if (!Array.isArray(value)) return invalid(`${label} 必须是字符串数组`);
    // An empty array is "not set": models fill unused fields that way. It only
    // gets an error when it is the only thing the call passed.
    if (value.length === 0) return valid([]);
    if (value.length > FETCH_BATCH_MAX) {
        return invalid(`${label} 最多 ${FETCH_BATCH_MAX} 项（现在 ${value.length} 项）`);
    }
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
        const item: unknown = value[index];
        if (typeof item !== 'string') return invalid(`${label} 第 ${index + 1} 项必须是字符串`);
        const text = item.trim();
        if (text === '') return invalid(`${label} 第 ${index + 1} 项是空的`);
        if (Array.from(text).length > maxChars) {
            return invalid(`${label} 第 ${index + 1} 项太长（最多 ${maxChars} 字）`);
        }
        items.push(text);
    }
    return valid(items);
};

const sourceValueOf = (source: FetchSource): string => {
    switch (source.kind) {
        case 'candidate':
            return source.id;
        case 'image':
            return source.id;
        case 'url':
            return source.url;
        case 'sticker':
            return source.query;
        case 'history':
            return source.reference;
        case 'avatar':
            return source.target;
    }
};

/** Duplicates inside one array are read once: `s1` twice is one picture */
const dedupeFetchSources = (
    sources: readonly FetchSource[]
): { readonly sources: readonly FetchSource[]; readonly skipped: readonly string[] } => {
    const seen = new Set<string>();
    const kept: FetchSource[] = [];
    const skipped: string[] = [];
    for (const source of sources) {
        const value = sourceValueOf(source);
        // Usernames compare case-insensitively, like the avatar cache does
        const normalized = source.kind === 'avatar' ? value.toLowerCase() : value;
        const key = `${source.kind}\u0000${normalized}`;
        if (seen.has(key)) {
            skipped.push(value);
            continue;
        }
        seen.add(key);
        kept.push(source);
    }
    return { sources: kept, skipped };
};

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

/** Values of a field that parsed cleanly; only called after every problem was answered */
const valueOfField = <T>(field: Field<T>, fallback: T): T => (field.ok ? field.value : fallback);

const fetchSourceOf = (kind: FetchSource['kind'], value: string): FetchSource => {
    switch (kind) {
        case 'candidate':
            return { kind, id: value };
        case 'image':
            return { kind, id: value };
        case 'url':
            return { kind, url: value };
        case 'sticker':
            return { kind, query: value };
        case 'history':
            return { kind, reference: value };
        case 'avatar':
            return { kind, target: value };
    }
};

/** Why one item is not a source of this lane, or null when it is */
const fetchSourceProblem = (
    kind: FetchSource['kind'],
    value: string,
    plural: boolean,
    itemIndex: number
): string | null => {
    switch (kind) {
        case 'candidate':
        case 'image':
            if (idPattern.test(value)) return null;
            return plural ? `第 ${itemIndex + 1} 项不是编号（要形如 s1 或 img1）` : '图片编号要形如 s1 或 img1';
        case 'url':
            if (isHttpUrl(value)) return null;
            return plural ? `第 ${itemIndex + 1} 项不是 http(s) 图片直链` : 'url 必须是 http(s) 图片直链';
        case 'sticker':
        case 'history':
        case 'avatar':
            return null;
    }
};

/** The singular and plural argument of one lane */
const LANE_FORMS: ReadonlyArray<{ readonly singular: string; readonly plural: string }> = [
    { singular: 'search_id', plural: 'search_ids' },
    { singular: 'url', plural: 'urls' },
    { singular: 'sticker', plural: 'stickers' },
    { singular: 'history', plural: 'histories' },
    { singular: 'avatar', plural: 'avatars' },
];

export const parseFetchImageArgs = (
    args: Readonly<Record<string, unknown>>
): ParsedFetchArgs => {
    const search = parseOptionalText(args.search_id, 'search_id', 16);
    const imageId = parseOptionalText(args.image_id, 'image_id', 16);
    const url = parseUrl(args.url);
    const sticker = parseOptionalText(args.sticker, 'sticker', 40);
    const history = parseOptionalText(args.history, 'history', 200);
    const avatar = parseOptionalText(args.avatar, 'avatar', 200);
    const searches = parseFetchTextArray(args.search_ids, 'search_ids', 16);
    const urls = parseFetchTextArray(args.urls, 'urls', 2048);
    const stickers = parseFetchTextArray(args.stickers, 'stickers', 40);
    const histories = parseFetchTextArray(args.histories, 'histories', 200);
    const avatars = parseFetchTextArray(args.avatars, 'avatars', 200);
    const imageIndex = parseImageIndex(args.image);
    const view = parseFetchView(args.view);

    const problems = problemsOf([
        search,
        imageId,
        url,
        sticker,
        history,
        avatar,
        searches,
        urls,
        stickers,
        histories,
        avatars,
        imageIndex,
        view,
    ]);
    if (problems.length > 0) return { ok: false, error: `参数有误：\n${problems.map((p) => `- ${p}`).join('\n')}` };

    const params: FetchParam[] = [];
    const addSingle = (kind: FetchSource['kind'], name: string, value: string): void => {
        if (value !== '') params.push({ kind, name, values: [value] });
    };
    addSingle('candidate', 'search_id', valueOfField(search, ''));
    addSingle('image', 'image_id', valueOfField(imageId, ''));
    addSingle('url', 'url', valueOfField(url, ''));
    addSingle('sticker', 'sticker', valueOfField(sticker, ''));
    addSingle('history', 'history', valueOfField(history, ''));
    addSingle('avatar', 'avatar', valueOfField(avatar, ''));
    const addPlural = (kind: FetchSource['kind'], name: string, values: readonly string[]): void => {
        if (values.length > 0) params.push({ kind, name, values });
    };
    addPlural('candidate', 'search_ids', valueOfField(searches, []));
    addPlural('url', 'urls', valueOfField(urls, []));
    addPlural('sticker', 'stickers', valueOfField(stickers, []));
    addPlural('history', 'histories', valueOfField(histories, []));
    addPlural('avatar', 'avatars', valueOfField(avatars, []));

    const PLURAL_NAMES = ['search_ids', 'urls', 'stickers', 'histories', 'avatars'] as const;
    const emptyPlural = PLURAL_NAMES.find((name) => {
        const value = args[name];
        return Array.isArray(value) && value.length === 0;
    });
    if (params.length === 0) {
        if (emptyPlural !== undefined) {
            return {
                ok: false,
                error:
                    `参数有误：\n- ${emptyPlural} 是空的：至少给 1 项（最多 ${FETCH_BATCH_MAX} 项），` +
                    '只读一张就用单数参数',
            };
        }
        return {
            ok: false,
            error: '参数有误：\n- search_id、image_id、url、sticker、history、avatar 必须传且只传一个',
        };
    }
    const chosen = params[0];
    if (chosen === undefined || params.length > 1) {
        if (chosen !== undefined) {
            // The same lane in both forms is its own mistake, not a batch one
            const single = LANE_FORMS.find(
                (lane) => params.some((param) => param.name === lane.singular) && params.some((param) => param.name === lane.plural)
            );
            if (single !== undefined) {
                return { ok: false, error: `参数有误：\n- ${single.singular} 和 ${single.plural} 只能传一个` };
            }
        }
        const base = '参数有误：\n- search_id、image_id、url、sticker、history、avatar 必须传且只传一个';
        const pluralGiven = params.some((param) => PLURAL_NAMES.some((name) => name === param.name));
        return {
            ok: false,
            error: pluralGiven
                ? `${base}\n- 批量读多张用同类复数参数（search_ids、urls、stickers、histories、avatars），不同类分两次调用`
                : base,
        };
    }
    if (!isAbsent(args.image) && chosen.name === 'histories') {
        return { ok: false, error: '参数有误：\n- image 只能和单个 history 一起用；histories 每条取第 1 张' };
    }
    if (!isAbsent(args.image) && chosen.name !== 'history') {
        return { ok: false, error: '参数有误：\n- image 只能和 history 一起用' };
    }

    const sources: FetchSource[] = [];
    for (const [index, value] of chosen.values.entries()) {
        const problem = fetchSourceProblem(chosen.kind, value, chosen.values.length > 1, index);
        if (problem === null) {
            sources.push(fetchSourceOf(chosen.kind, value));
            continue;
        }
        const subject = chosen.values.length > 1 ? `${chosen.name} ` : '';
        return { ok: false, error: `参数有误：\n- ${subject}${problem}` };
    }

    const deduped = dedupeFetchSources(sources);
    return {
        ok: true,
        args: {
            sources: deduped.sources,
            skippedDuplicates: deduped.skipped,
            image: chosen.name === 'history' && imageIndex.ok ? imageIndex.value : 1,
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
