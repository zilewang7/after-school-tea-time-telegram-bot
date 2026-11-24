/**
 * search_by_image: one picture from the conversation (or from an earlier
 * search/read) goes to the engines, and the merged lists come back as text.
 *
 * Yandex is the primary channel (general pages, other sizes, similar pictures);
 * SauceNAO joins it for anime/illustrations or when Yandex finds nothing, and
 * trace.moe only when the call names it. The pictures in the answer are
 * registered as ordinary `sN` candidates, so send_image / fetch_image can use a
 * larger version or a similar picture without a second download path. The tool
 * itself sends nothing.
 */
import { sniffMediaMime, type SniffedMediaMime } from '../../ai/image-generation/image-mime.js';
import type { ToolHandler } from '../../ai/tools/tool-types.js';
import { fetchImageBytes } from '../../services/image-fetch-service.js';
import {
    MAX_REVERSE_SEARCH_BYTES,
    searchByImage,
    type ReverseSearchOptions,
    type ReverseSearchOutcome,
} from '../../services/image-reverse-search-service.js';
import type {
    ParsedReverseSearch,
    ReverseSearchSimilar,
    ReverseSearchSize,
} from '../../services/image-reverse-search-types.js';
import { loadMessageImages } from '../commands/reference-images.js';
import { loadAnimationFrame, type AnimationFrameLoader } from './animation-frame.js';
import { imageToolError } from './image-tool-result.js';
import {
    parseSearchByImageArgs,
    type ParsedSearchByImageArgs,
    type SearchByImageArgs,
} from './media-tool-args.js';
import { loadContextImages, type MessageImageLoader } from './image-references.js';
import { downloadCandidateMedia, type ImageFetch } from './image-source-download.js';
import {
    allocateCandidateIds,
    type ReplyMediaState,
    type SearchCandidate,
} from './reply-media-state.js';
import type { ReplyToolContext } from './reply-tool-context.js';
import { formatReverseSearchResult } from './reverse-image-text.js';
import { SEARCH_BY_IMAGE_TOOL_NAME } from './tool-names.js';
import { traceParts } from './tool-trace.js';

const DESCRIPTION =
    '以图搜图：将图片上传至 Yandex 图片搜索，返回包含该图的网页、其他尺寸、相似图与识别标签；' +
    '二次元/插画会补充 SauceNAO 图库（Pixiv、X、Danbooru 等出处，带相似度百分比），也可用 engine 指定引擎。' +
    'SauceNAO 结果可能含 R-18 标题与链接，默认不过滤；传 safe=true 只保留 Known Safe 图库结果。' +
    '支持传入上下文消息图片（message / image）、已读取图片（image_id）或搜索候选（search_id）；' +
    '动图（GIF/动态贴纸）取首帧，单图上限 8MB。';

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        message: {
            type: 'integer',
            minimum: 1,
            description: '上下文里的消息编号（#N 里的数字）',
        },
        image: {
            type: 'integer',
            minimum: 1,
            description: '这条消息里的第几张图，从 1 开始（附件在前，链接预览在后）；省略=第一张',
        },
        image_id: { type: 'string', description: "fetch_image 读过的图编号，形如 'img1'" },
        search_id: { type: 'string', description: "search_images 的候选编号，形如 's3'" },
        engine: {
            type: 'string',
            enum: ['auto', 'yandex', 'saucenao', 'tracemoe'],
            description:
                '引擎：auto 默认（Yandex 通用来源，二次元/插画补充 SauceNAO 图库）；' +
                'yandex 只查通用来源；saucenao 只查二次元图库（Pixiv/X/Danbooru 等出处，返回相似度）；' +
                'tracemoe 只查动画截帧出处（哪部番、第几集、时间点）',
        },
        safe: {
            type: 'boolean',
            description: 'SauceNAO 的 R-18 过滤：false（默认）不过滤；true 只保留 Known Safe 图库结果',
        },
    },
};

/** One reply may spend this many real (non-cached) searches; counted in the media state */
export const MAX_SEARCHES_PER_REPLY = 3;
/** Pictures shown (and registered as sN) per list */
const MAX_SIZES_PER_REPLY = 4;
const MAX_SIMILAR_PER_REPLY = 4;

export interface SearchByImageDependencies {
    readonly search: (options: ReverseSearchOptions) => Promise<ReverseSearchOutcome>;
    readonly loadMessageImages: MessageImageLoader;
    readonly loadAnimationFrame: AnimationFrameLoader;
    readonly fetchImage: ImageFetch;
}

export interface SearchByImageToolOptions {
    readonly state: ReplyMediaState;
    readonly context: ReplyToolContext;
    /** Tests replace the network and the database loader */
    readonly dependencies?: Partial<SearchByImageDependencies>;
}

const PRODUCTION_DEPENDENCIES: SearchByImageDependencies = {
    search: searchByImage,
    loadMessageImages,
    loadAnimationFrame,
    fetchImage: fetchImageBytes,
};

interface SourceImage {
    readonly data: Buffer;
    readonly mimeType: SniffedMediaMime;
}

type ResolvedSource =
    | { readonly ok: true; readonly image: SourceImage; readonly label: string }
    | { readonly ok: false; readonly error: string };

const megabytes = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

const checkImage = (data: Buffer, label: string): ResolvedSource => {
    const mimeType = sniffMediaMime(data);
    if (mimeType === null) {
        return { ok: false, error: `${label}不是 PNG/JPEG/WebP/GIF 图片，没法以图搜图。` };
    }
    if (data.length > MAX_REVERSE_SEARCH_BYTES) {
        return { ok: false, error: `${label}有 ${megabytes(data.length)}MB，超过以图搜图上限 8MB。` };
    }
    return { ok: true, image: { data, mimeType }, label };
};

const domainOf = (rawUrl: string): string => {
    try {
        return new URL(rawUrl).hostname.replace(/^www\./, '');
    } catch {
        return rawUrl;
    }
};

const candidateOfSize = (id: string, size: ReverseSearchSize): SearchCandidate => ({
    id,
    searchId: 'reverse',
    title: `${size.width}×${size.height}`,
    sourcePage: size.url,
    domain: domainOf(size.url),
    imageUrl: size.url,
    thumbnailUrl: size.url,
    width: size.width,
    height: size.height,
    sendKind: 'static',
});

const candidateOfSimilar = (id: string, item: ReverseSearchSimilar): SearchCandidate => ({
    id,
    searchId: 'reverse',
    title: item.title,
    sourcePage: item.imageUrl,
    domain: domainOf(item.imageUrl),
    imageUrl: item.imageUrl,
    thumbnailUrl: item.imageUrl,
    sendKind: 'static',
});

interface RegisteredResults {
    readonly sizes: readonly SearchCandidate[];
    readonly similar: readonly SearchCandidate[];
}

/** Turn the two picture lists into `sN` candidates of this reply */
const registerResults = (state: ReplyMediaState, result: ParsedReverseSearch): RegisteredResults => {
    const shownSizes = result.sizes.slice(0, MAX_SIZES_PER_REPLY);
    const shownSimilar = result.similar.slice(0, MAX_SIMILAR_PER_REPLY);
    const ids = allocateCandidateIds(state, shownSizes.length + shownSimilar.length);

    const sizes: SearchCandidate[] = [];
    for (const [index, size] of shownSizes.entries()) {
        const id = ids[index];
        if (id !== undefined) sizes.push(candidateOfSize(id, size));
    }

    const similar: SearchCandidate[] = [];
    for (const [index, item] of shownSimilar.entries()) {
        const id = ids[shownSizes.length + index];
        if (id !== undefined) similar.push(candidateOfSimilar(id, item));
    }

    for (const candidate of [...sizes, ...similar]) {
        state.candidates.set(candidate.id, candidate);
    }
    return { sizes, similar };
};

/** `#3 第 2 张` / `img1` / `s3`: the one picture source the call named */
const describeSearchByImageArgument = (args: SearchByImageArgs): string => {
    if (args.message !== undefined) {
        return args.image === undefined || args.image === 1
            ? `#${args.message}`
            : `#${args.message} 第 ${args.image} 张`;
    }
    return args.imageId ?? args.searchId ?? '';
};

export const createSearchByImageTool = (options: SearchByImageToolOptions): ToolHandler => {
    const { state, context } = options;
    const dependencies: SearchByImageDependencies = {
        ...PRODUCTION_DEPENDENCIES,
        ...options.dependencies,
    };

    const resolveMessageImage = async (message: number, imageIndex: number): Promise<ResolvedSource> => {
        const entry = context.contextIndex.get(message);
        if (!entry) return { ok: false, error: `#${message} 不在当前上下文里。` };

        const loaded = await loadContextImages(
            context.chatId,
            entry,
            dependencies.loadMessageImages,
            dependencies.loadAnimationFrame
        );
        if (loaded.length === 0) return { ok: false, error: `#${message} 这条消息没有可用的图片。` };

        const picked = loaded[imageIndex - 1];
        if (!picked) {
            return { ok: false, error: `#${message} 只有 ${loaded.length} 张图，没有第 ${imageIndex} 张。` };
        }
        if (picked.kind === 'cloud') {
            return { ok: false, error: `#${message} 的图存在云端（超过 20MB），没法以图搜图。` };
        }

        const label = loaded.length > 1 ? `#${message} 的第 ${imageIndex} 张图` : `#${message} 的图`;
        return checkImage(picked.data, label);
    };

    const resolveFetchedImage = (imageId: string): ResolvedSource => {
        const fetched = state.fetched.get(imageId);
        if (!fetched) return { ok: false, error: `没有读过的图 ${imageId}。` };
        return checkImage(fetched.data, imageId);
    };

    const resolveCandidateImage = async (searchId: string): Promise<ResolvedSource> => {
        const candidate = state.candidates.get(searchId);
        if (!candidate) return { ok: false, error: `没有候选 ${searchId}。` };

        const downloaded = await downloadCandidateMedia(candidate, {
            fetchImage: dependencies.fetchImage,
            signal: context.signal,
        });
        if (!downloaded.ok) return { ok: false, error: `图片没取到：${downloaded.error}` };
        return checkImage(downloaded.media.deliverable.data, searchId);
    };

    const resolveSource = async (args: ParsedSearchByImageArgs): Promise<ResolvedSource> => {
        if (!args.ok) return { ok: false, error: args.error };
        const parsed = args.args;
        if (parsed.message !== undefined) return resolveMessageImage(parsed.message, parsed.image ?? 1);
        if (parsed.imageId !== undefined) return resolveFetchedImage(parsed.imageId);
        if (parsed.searchId !== undefined) return resolveCandidateImage(parsed.searchId);
        return { ok: false, error: '没有图片输入。' };
    };

    return {
        definition: {
            name: SEARCH_BY_IMAGE_TOOL_NAME,
            description: DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
        },
        statusText: '🔎 正在以图搜图…',
        chatAction: 'typing',
        execute: async (rawArgs) => {
            const args = parseSearchByImageArgs(rawArgs);
            if (!args.ok) return imageToolError(args.error);
            if (state.reverseSearchCount >= MAX_SEARCHES_PER_REPLY) {
                return imageToolError(`本次回复已经做过 ${MAX_SEARCHES_PER_REPLY} 次以图搜图，达到上限。`);
            }

            const traceArgument = describeSearchByImageArgument(args.args);
            const resolved = await resolveSource(args);
            if (!resolved.ok) return imageToolError(resolved.error);

            const outcome = await dependencies.search({
                bytes: resolved.image.data,
                mimeType: resolved.image.mimeType,
                signal: context.signal,
                engine: args.args.engine,
                safe: args.args.safe,
            });
            if (!outcome.ok) return imageToolError(outcome.error);
            if (!outcome.cached) state.reverseSearchCount += 1;

            const registered = registerResults(state, outcome.result);
            const engineRuns = outcome.result.engines
                .map((run) => `${run.engine}:${run.status}${run.cached ? '(cache)' : ''}`)
                .join(',');
            console.log(
                `[search-by-image] source=${resolved.label} cached=${outcome.cached} ` +
                    `sites=${outcome.result.sites.length} sizes=${registered.sizes.length} ` +
                    `similar=${registered.similar.length} tags=${outcome.result.tags.length} ` +
                    `engines=${engineRuns}`
            );

            const totalResults =
                outcome.result.sites.length + registered.sizes.length + registered.similar.length;
            return {
                content: formatReverseSearchResult({
                    result: outcome.result,
                    sizes: registered.sizes,
                    similar: registered.similar,
                    cached: outcome.cached,
                    safe:
                        args.args.safe &&
                        outcome.result.engines.some((run) => run.engine === 'saucenao' && run.status === 'ok'),
                }),
                isError: false,
                images: [],
                record: null,
                trace: {
                    argument: traceArgument,
                    result:
                        totalResults === 0
                            ? '无结果'
                            : traceParts(
                                  `来源 ${outcome.result.sites.length}`,
                                  `尺寸 ${registered.sizes.length}`,
                                  `相似 ${registered.similar.length}`
                              ),
                },
            };
        },
    };
};
