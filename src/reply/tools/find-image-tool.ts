/**
 * find_image: the merged 2-in-1 image discovery tool (`mode: 'web' | 'reverse'`).
 *
 * Prunes `mode.enum` and the disabled side's properties based on
 * `webEnabled` / `reverseEnabled`, auto-defaults `mode` when only one mode is
 * enabled, and rejects calls targeting a disabled mode.
 */
import { match } from 'ts-pattern';
import { sniffMediaMime, type SniffedMediaMime } from '../../ai/image-generation/image-mime.js';
import type { ToolHandler, ToolModelImage, ToolResult } from '../../ai/tools/tool-types.js';
import { fetchImageBytes, type ImageFetchOutcome } from '../../services/image-fetch-service.js';
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
import type { ImageSearchOptions, ImageSearchOutcome, SearchedImage } from '../../services/image-search-service.js';
import { loadMessageImages } from '../commands/reference-images.js';
import { loadAnimationFrame, type AnimationFrameLoader } from './animation-frame.js';
import { loadContextImages, type MessageImageLoader } from './image-references.js';
import { downloadCandidateMedia, type ImageFetch } from './image-source-download.js';
import { imageToolError } from './image-tool-result.js';
import { formatSearchResult, mediaToolErrors } from './image-tool-text.js';
import {
    parseSearchByImageArgs,
    parseSearchImagesArgs,
    type ParsedSearchByImageArgs,
    type SearchByImageArgs,
} from './media-tool-args.js';
import {
    allocateCandidateIds,
    nextSearchId,
    thumbnailWindowSize,
    unseenCandidates,
    type ReplyMediaState,
    type SearchCandidate,
    type SearchSet,
} from './reply-media-state.js';
import type { ReplyToolContext } from './reply-tool-context.js';
import { formatReverseSearchResult } from './reverse-image-text.js';
import { FIND_IMAGE_TOOL_NAME } from './tool-names.js';
import { traceParts, traceQuote } from './tool-trace.js';

export const MAX_REVERSE_SEARCHES_PER_REPLY = 3;
export const THUMBNAIL_LIMITS = {
    maxBytes: 512 * 1024,
    timeoutMs: 3000,
} as const;
const MAX_SIZES_PER_REPLY = 4;
const MAX_SIMILAR_PER_REPLY = 4;

export interface FindImageWebDependencies {
    readonly search: (options: ImageSearchOptions) => Promise<ImageSearchOutcome>;
    readonly fetchThumbnail: (url: string) => Promise<ImageFetchOutcome>;
    readonly baseUrl: string;
    readonly engines: string;
    readonly safesearch: 0 | 1 | 2;
    readonly canSeeImages: boolean;
}

export interface FindImageReverseDependencies {
    readonly search: (options: ReverseSearchOptions) => Promise<ReverseSearchOutcome>;
    readonly loadMessageImages: MessageImageLoader;
    readonly loadAnimationFrame: AnimationFrameLoader;
    readonly fetchImage: ImageFetch;
}

export interface FindImageToolOptions {
    readonly state: ReplyMediaState;
    readonly webEnabled: boolean;
    readonly reverseEnabled: boolean;
    readonly webDependencies?: FindImageWebDependencies;
    readonly context?: ReplyToolContext;
    readonly reverseDependencies?: Partial<FindImageReverseDependencies>;
}

const PRODUCTION_REVERSE_DEPENDENCIES: FindImageReverseDependencies = {
    search: searchByImage,
    loadMessageImages,
    loadAnimationFrame,
    fetchImage: fetchImageBytes,
};

type FindImageMode = 'web' | 'reverse';

const descriptionOf = (
    webEnabled: boolean,
    reverseEnabled: boolean,
    canSeeImages: boolean
): string => {
    const parts: string[] = [];
    if (webEnabled) {
        parts.push(
            canSeeImages
                ? 'mode="web"：按关键词搜网络图，返回候选 s1、s2…（首次附前3张缩略图，后续附剩余全部；view="details" 仅清单）。'
                : 'mode="web"：按关键词搜网络图，返回候选 s1、s2… 尺寸/格式/来源清单（当前模型无图，可据此选后 send_image）。'
        );
    }
    if (reverseEnabled) {
        parts.push(
            'mode="reverse"：以图搜图查出处（Yandex 通用+二次元补 SauceNAO，支持 tracemoe；动图取首帧，上限 8MB），结果也登记为 sN 候选。'
        );
    }
    return parts.join('');
};

const inputSchemaOf = (webEnabled: boolean, reverseEnabled: boolean): Readonly<Record<string, unknown>> => {
    const modes: FindImageMode[] = [
        ...(webEnabled ? (['web'] as const) : []),
        ...(reverseEnabled ? (['reverse'] as const) : []),
    ];
    return {
        type: 'object',
        properties: {
            mode: {
                type: 'string',
                enum: modes,
                description:
                    webEnabled && reverseEnabled
                        ? 'web=关键词搜网图；reverse=以图搜图'
                        : webEnabled
                          ? '固定 web（关键词搜网图）'
                          : '固定 reverse（以图搜图）',
            },
            ...(webEnabled
                ? {
                      query: { type: 'string', description: 'web 搜索关键词，与 search 二选一' },
                      search: { type: 'string', description: 'web 翻页已有集合（如 q1），与 query 二选一' },
                      count: { type: 'integer', minimum: 1, maximum: 8, description: 'web 候选数，默认8' },
                      view: {
                          type: 'string',
                          enum: ['thumbnails', 'details'],
                          description: 'web 返回：thumbnails（默认看图）/ details（纯清单）',
                      },
                  }
                : {}),
            ...(reverseEnabled
                ? {
                      message: { type: 'integer', minimum: 1, description: 'reverse 上下文消息编号 #N' },
                      image: { type: 'integer', minimum: 1, description: 'reverse 该消息第几张图，默认1' },
                      image_id: { type: 'string', description: "reverse 已读图编号（如 'img1'）" },
                      search_id: { type: 'string', description: "reverse 候选图编号（如 's3'）" },
                      engine: {
                          type: 'string',
                          enum: ['auto', 'yandex', 'saucenao', 'tracemoe'],
                          description: 'reverse 引擎（auto/yandex/saucenao/tracemoe）',
                      },
                      safe: {
                          type: 'boolean',
                          description: 'reverse SauceNAO R-18 过滤，默认 false',
                      },
                  }
                : {}),
        },
        required: webEnabled && reverseEnabled ? ['mode'] : [],
    };
};

const normalizeQuery = (query: string): string => query.replace(/\s+/g, ' ').trim();

const toCandidate = (searchId: string, id: string, image: SearchedImage): SearchCandidate => ({
    id,
    searchId,
    title: image.title,
    sourcePage: image.sourcePage,
    domain: image.domain,
    imageUrl: image.imageUrl,
    thumbnailUrl: image.thumbnailUrl,
    ...(image.width === undefined ? {} : { width: image.width }),
    ...(image.height === undefined ? {} : { height: image.height }),
    ...(image.format === undefined ? {} : { format: image.format }),
    sendKind: image.sendKind,
});

const newSearchSet = (state: ReplyMediaState, query: string, images: readonly SearchedImage[]): SearchSet => {
    const id = nextSearchId(state);
    const ids = allocateCandidateIds(state, images.length);
    const candidates = images.map((image, index) => toCandidate(id, ids[index] ?? `s${index + 1}`, image));
    const set: SearchSet = { id, query, candidates, viewedIds: new Set() };
    state.searches.set(id, set);
    for (const candidate of candidates) state.candidates.set(candidate.id, candidate);
    return set;
};

const findExistingSet = (state: ReplyMediaState, query: string): SearchSet | undefined =>
    [...state.searches.values()].find((set) => set.query.toLowerCase() === query.toLowerCase());

const attachThumbnails = async (
    state: ReplyMediaState,
    dependencies: FindImageWebDependencies,
    set: SearchSet
): Promise<{
    readonly attached: readonly SearchCandidate[];
    readonly failed: readonly SearchCandidate[];
    readonly modelImages: readonly ToolModelImage[];
}> => {
    const window = unseenCandidates(set).slice(0, thumbnailWindowSize(state, set));
    const results = await Promise.all(
        window.map(async (candidate) => ({
            candidate,
            outcome: await dependencies.fetchThumbnail(candidate.thumbnailUrl),
        }))
    );
    const attached: SearchCandidate[] = [];
    const failed: SearchCandidate[] = [];
    const modelImages: ToolModelImage[] = [];

    for (const { candidate, outcome } of results) {
        if (!outcome.ok) {
            console.log(`[find_image] thumbnail ${candidate.id} failed: ${outcome.error}`);
            failed.push(candidate);
            continue;
        }
        set.viewedIds.add(candidate.id);
        attached.push(candidate);
        modelImages.push({
            data: outcome.image.data,
            mimeType: outcome.image.mimeType,
            caption: `[${candidate.id}] ${candidate.title} — ${candidate.domain}`,
        });
    }
    state.thumbnailCount += attached.length;
    return { attached, failed, modelImages };
};

const executeWebMode = async (
    rawArgs: Readonly<Record<string, unknown>>,
    state: ReplyMediaState,
    dependencies: FindImageWebDependencies
): Promise<ToolResult> => {
    const parsed = parseSearchImagesArgs(rawArgs);
    if (!parsed.ok) return imageToolError(parsed.error);
    const args = parsed.args;
    const traceArgument = traceParts(
        'web',
        args.searchId === undefined ? traceQuote(args.query ?? '') : `${args.searchId} 翻页`,
        args.view === 'details' ? 'details' : null
    );

    let set: SearchSet;
    let reused = false;
    if (args.searchId !== undefined) {
        const existing = state.searches.get(args.searchId);
        if (!existing) return imageToolError(mediaToolErrors.unknownSet(args.searchId, state));
        set = existing;
    } else {
        const query = normalizeQuery(args.query ?? '');
        const existing = findExistingSet(state, query);
        if (existing) {
            set = existing;
            reused = true;
        } else {
            const outcome = await dependencies.search({
                query,
                count: args.count,
                safesearch: dependencies.safesearch,
                engines: dependencies.engines,
                baseUrl: dependencies.baseUrl,
            });
            if (!outcome.ok) return imageToolError(`图片搜索不可用：${outcome.error}。`);
            if (outcome.images.length === 0) return imageToolError(`「${query}」未搜到可用图片，可尝试更换关键词。`);
            set = newSearchSet(state, query, outcome.images);
        }
    }

    const unseenBefore = unseenCandidates(set).length;
    if (args.view === 'thumbnails' && unseenBefore === 0) {
        return imageToolError(mediaToolErrors.noMoreThumbnails(set.id));
    }

    const attachStartedAt = Date.now();
    const { attached, failed, modelImages } =
        args.view === 'thumbnails' && dependencies.canSeeImages
            ? await attachThumbnails(state, dependencies, set)
            : { attached: [], failed: [], modelImages: [] };

    const windowIds = attached.map((candidate) => candidate.id);
    console.log(
        `[find_image:web] search=${set.id} view=${args.view} ` +
            `window=${windowIds.length > 0 ? `${windowIds[0]}..${windowIds.at(-1)}` : '-'} ` +
            `thumbs=${attached.length}/${attached.length + failed.length} ` +
            `served=${state.thumbnailCount} ms=${Date.now() - attachStartedAt}`
    );

    const content = formatSearchResult({
        set,
        attached,
        failed,
        view: args.view,
        canSeeImages: dependencies.canSeeImages,
        reused,
        toolName: FIND_IMAGE_TOOL_NAME,
    });
    const unseenAfter = unseenCandidates(set).length;
    const traceResult =
        args.searchId === undefined
            ? traceParts(
                  reused ? `复用 ${set.id}` : set.id,
                  `${set.candidates.length} 条候选`,
                  attached.length > 0 ? `附 ${attached.length} 张` : null
              )
            : traceParts(
                  attached.length > 0 ? `附 ${attached.length} 张` : `${set.candidates.length} 条候选`,
                  `剩 ${unseenAfter} 张`
              );

    return {
        content,
        isError: false,
        images: [],
        ...(modelImages.length > 0 ? { modelImages } : {}),
        record: {
            provider: 'mcp',
            searchQueries: [`${FIND_IMAGE_TOOL_NAME}: ${set.id} 「${set.query}」`],
            citations: [],
        },
        trace: { argument: traceArgument, result: traceResult },
    };
};

interface SourceImage {
    readonly data: Buffer;
    readonly mimeType: SniffedMediaMime;
}

type ResolvedSource =
    | { readonly ok: true; readonly image: SourceImage; readonly label: string }
    | { readonly ok: false; readonly error: string };

const checkImage = (data: Buffer, label: string): ResolvedSource => {
    const mimeType = sniffMediaMime(data);
    if (mimeType === null) {
        return { ok: false, error: `${label}不是 PNG/JPEG/WebP/GIF 图片，没法以图搜图。` };
    }
    if (data.length > MAX_REVERSE_SEARCH_BYTES) {
        const mb = (data.length / (1024 * 1024)).toFixed(1);
        return { ok: false, error: `${label}有 ${mb}MB，超过以图搜图上限 8MB。` };
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

const registerReverseResults = (
    state: ReplyMediaState,
    result: ParsedReverseSearch
): { readonly sizes: readonly SearchCandidate[]; readonly similar: readonly SearchCandidate[] } => {
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
    for (const candidate of [...sizes, ...similar]) state.candidates.set(candidate.id, candidate);
    return { sizes, similar };
};

const describeReverseArgument = (args: SearchByImageArgs): string => {
    if (args.message !== undefined) {
        return args.image === undefined || args.image === 1
            ? `#${args.message}`
            : `#${args.message} 第 ${args.image} 张`;
    }
    return args.imageId ?? args.searchId ?? '';
};

const resolveReverseSource = async (
    parsedArgs: ParsedSearchByImageArgs,
    state: ReplyMediaState,
    context: ReplyToolContext,
    dependencies: FindImageReverseDependencies
): Promise<ResolvedSource> => {
    if (!parsedArgs.ok) return { ok: false, error: parsedArgs.error };
    const parsed = parsedArgs.args;
    if (parsed.message !== undefined) {
        const entry = context.contextIndex.get(parsed.message);
        if (!entry) return { ok: false, error: `#${parsed.message} 不在当前上下文里。` };
        const loaded = await loadContextImages(
            context.chatId,
            entry,
            dependencies.loadMessageImages,
            dependencies.loadAnimationFrame
        );
        if (loaded.length === 0) return { ok: false, error: `#${parsed.message} 这条消息没有可用的图片。` };
        const index = parsed.image ?? 1;
        const picked = loaded[index - 1];
        if (!picked) {
            return { ok: false, error: `#${parsed.message} 只有 ${loaded.length} 张图，没有第 ${index} 张。` };
        }
        if (picked.kind === 'cloud') {
            return { ok: false, error: `#${parsed.message} 的图存在云端（超过 20MB），没法以图搜图。` };
        }
        const label = loaded.length > 1 ? `#${parsed.message} 的第 ${index} 张图` : `#${parsed.message} 的图`;
        return checkImage(picked.data, label);
    }
    if (parsed.imageId !== undefined) {
        const fetched = state.fetched.get(parsed.imageId);
        if (!fetched) return { ok: false, error: `没有读过的图 ${parsed.imageId}。` };
        return checkImage(fetched.data, parsed.imageId);
    }
    if (parsed.searchId !== undefined) {
        const candidate = state.candidates.get(parsed.searchId);
        if (!candidate) return { ok: false, error: `没有候选 ${parsed.searchId}。` };
        const downloaded = await downloadCandidateMedia(candidate, {
            fetchImage: dependencies.fetchImage,
            signal: context.signal,
        });
        if (!downloaded.ok) return { ok: false, error: `图片没取到：${downloaded.error}` };
        return checkImage(downloaded.media.deliverable.data, parsed.searchId);
    }
    return { ok: false, error: '没有图片输入。' };
};

const executeReverseMode = async (
    rawArgs: Readonly<Record<string, unknown>>,
    state: ReplyMediaState,
    context: ReplyToolContext,
    dependencies: FindImageReverseDependencies
): Promise<ToolResult> => {
    const args = parseSearchByImageArgs(rawArgs);
    if (!args.ok) return imageToolError(args.error);
    if (state.reverseSearchCount >= MAX_REVERSE_SEARCHES_PER_REPLY) {
        return imageToolError(`本次回复已经做过 ${MAX_REVERSE_SEARCHES_PER_REPLY} 次以图搜图，达到上限。`);
    }
    const traceArgument = traceParts('reverse', describeReverseArgument(args.args));
    const resolved = await resolveReverseSource(args, state, context, dependencies);
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

    const registered = registerReverseResults(state, outcome.result);
    const engineRuns = outcome.result.engines
        .map((run) => `${run.engine}:${run.status}${run.cached ? '(cache)' : ''}`)
        .join(',');
    console.log(
        `[find_image:reverse] source=${resolved.label} cached=${outcome.cached} ` +
            `sites=${outcome.result.sites.length} sizes=${registered.sizes.length} ` +
            `similar=${registered.similar.length} tags=${outcome.result.tags.length} engines=${engineRuns}`
    );

    const totalResults = outcome.result.sites.length + registered.sizes.length + registered.similar.length;
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
};

const resolveMode = (
    rawMode: unknown,
    webEnabled: boolean,
    reverseEnabled: boolean
): { readonly ok: true; readonly mode: FindImageMode } | { readonly ok: false; readonly error: string } => {
    if (rawMode === undefined || rawMode === null || (typeof rawMode === 'string' && rawMode.trim() === '')) {
        if (webEnabled && !reverseEnabled) return { ok: true, mode: 'web' };
        if (!webEnabled && reverseEnabled) return { ok: true, mode: 'reverse' };
        return { ok: false, error: '参数有误：\n- mode 必须传 "web"（关键词搜图）或 "reverse"（以图搜图）' };
    }
    if (rawMode === 'web') {
        return webEnabled
            ? { ok: true, mode: 'web' }
            : { ok: false, error: '当前未开启关键词网图搜索（mode="web"）。' };
    }
    if (rawMode === 'reverse') {
        return reverseEnabled
            ? { ok: true, mode: 'reverse' }
            : { ok: false, error: '当前未开启以图搜图（mode="reverse"）。' };
    }
    return { ok: false, error: '参数有误：\n- mode 只能是 "web" 或 "reverse"' };
};

export const createFindImageTool = (options: FindImageToolOptions): ToolHandler => {
    const { state, webEnabled, reverseEnabled } = options;
    const canSeeImages = options.webDependencies?.canSeeImages ?? false;
    const reverseDependencies: FindImageReverseDependencies = {
        ...PRODUCTION_REVERSE_DEPENDENCIES,
        ...options.reverseDependencies,
    };

    return {
        definition: {
            name: FIND_IMAGE_TOOL_NAME,
            description: descriptionOf(webEnabled, reverseEnabled, canSeeImages),
            inputSchema: inputSchemaOf(webEnabled, reverseEnabled),
        },
        statusText: (args) => {
            if (args.mode === 'reverse') return '🔎 正在以图搜图…';
            if (args.mode === 'web') return '🔍 正在找图…';
            return !webEnabled && reverseEnabled ? '🔎 正在以图搜图…' : '🔍 正在找图…';
        },
        chatAction: 'typing',
        execute: async (rawArgs) => {
            const resolvedMode = resolveMode(rawArgs.mode, webEnabled, reverseEnabled);
            if (!resolvedMode.ok) return imageToolError(resolvedMode.error);
            return match(resolvedMode.mode)
                .with('web', () => {
                    if (options.webDependencies === undefined) {
                        return Promise.resolve(imageToolError('网图搜索未配置。'));
                    }
                    return executeWebMode(rawArgs, state, options.webDependencies);
                })
                .with('reverse', () => {
                    if (options.context === undefined) {
                        return Promise.resolve(imageToolError('以图搜图缺少上下文。'));
                    }
                    return executeReverseMode(rawArgs, state, options.context, reverseDependencies);
                })
                .exhaustive();
        },
    };
};
