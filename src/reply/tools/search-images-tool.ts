/**
 * search_images: find real pictures on the web, hand the model candidate ids
 * and (when it can see) a few thumbnails to choose from.
 *
 * Paging is deliberately lopsided: the reply's first search shows three
 * pictures, every later search shows all that batch's unseen pictures at once.
 * A tool round costs far more than a handful of image tokens, which is why
 * there is no third and fourth window.
 */
import type { ImageFetchOutcome } from '../../services/image-fetch-service.js';
import type { ImageSearchOptions, ImageSearchOutcome, SearchedImage } from '../../services/image-search-service.js';
import type { ToolHandler, ToolModelImage } from '../../ai/tools/tool-types.js';
import { imageToolError } from './image-tool-result.js';
import { formatSearchResult, mediaToolErrors } from './image-tool-text.js';
import { parseSearchImagesArgs } from './media-tool-args.js';
import {
    allocateCandidateIds,
    nextSearchId,
    thumbnailWindowSize,
    unseenCandidates,
    type ReplyMediaState,
    type SearchCandidate,
    type SearchSet,
} from './reply-media-state.js';
import { SEARCH_IMAGES_TOOL_NAME } from './tool-names.js';

const DESCRIPTION_WITH_IMAGES =
    '在网上搜索真实存在的图片（表情包、梗图、截图、新闻图、参考照片）。' +
    '返回编号 s1、s2…，尺寸/格式/来源页。本回复的第一次搜索先附 3 张缩略图；' +
    '之后每次搜索（包括换关键词）都会把该批剩下的缩略图一次全给你（不会重复搜索）。' +
    "只想看文字清单用 view='details'；想单张细看用 fetch_image。" +
    '用户要图就用 send_image 发一张（不必等最完美）；' +
    '用户要的是“找现成的图”时用本工具；只有用户明确要“画一张/改图”才用 generate_image。';

/** For a model that cannot see: no thumbnails are attached, so do not promise any */
const DESCRIPTION_TEXT_ONLY =
    '在网上搜索真实存在的图片（表情包、梗图、截图、新闻图、参考照片）。' +
    '返回编号 s1、s2…，尺寸/格式/来源页和候选清单。' +
    '你看不到图片内容，按标题、尺寸和来源挑。' +
    '挑到就用 send_image 发出去。' +
    '用户要的是“现成的图”时用本工具；只有用户明确要“画一张/改图”才用 generate_image。';

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        query: {
            type: 'string',
            description: '要搜什么，例如“医生淳平 表情包”。和 search 二选一。',
        },
        search: {
            type: 'string',
            description:
                "已有搜索集合编号（形如 q1）。在这批结果里继续看没看过的缩略图，不会重新搜索。和 query 二选一。",
        },
        count: {
            type: 'integer',
            minimum: 1,
            maximum: 8,
            description: '新搜索保留多少条候选，默认 8。',
        },
        view: {
            type: 'string',
            enum: ['thumbnails', 'details'],
            description: "thumbnails（默认）= 看图；details = 只回文字清单、不附图。",
        },
    },
};

const THUMBNAIL_MAX_BYTES = 512 * 1024;
const THUMBNAIL_TIMEOUT_MS = 3000;

export interface SearchImagesToolDependencies {
    readonly search: (options: ImageSearchOptions) => Promise<ImageSearchOutcome>;
    readonly fetchThumbnail: (url: string) => Promise<ImageFetchOutcome>;
    readonly baseUrl: string;
    readonly engines: string;
    readonly safesearch: 0 | 1 | 2;
    /** False: the model gets metadata only, no pictures */
    readonly canSeeImages: boolean;
}

export interface SearchImagesToolOptions {
    readonly state: ReplyMediaState;
    readonly dependencies: SearchImagesToolDependencies;
}

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

const newSearchSet = (
    state: ReplyMediaState,
    query: string,
    images: readonly SearchedImage[]
): SearchSet => {
    const id = nextSearchId(state);
    const ids = allocateCandidateIds(state, images.length);
    const candidates = images.map((image, index) => toCandidate(id, ids[index] ?? `s${index + 1}`, image));

    const set: SearchSet = { id, query, candidates, viewedIds: new Set() };
    state.searches.set(id, set);
    for (const candidate of candidates) {
        state.candidates.set(candidate.id, candidate);
    }
    return set;
};

const findExistingSet = (state: ReplyMediaState, query: string): SearchSet | undefined =>
    [...state.searches.values()].find((set) => set.query.toLowerCase() === query.toLowerCase());

interface AttachedThumbnails {
    readonly attached: readonly SearchCandidate[];
    readonly failed: readonly SearchCandidate[];
    readonly modelImages: readonly ToolModelImage[];
}

/** Download this window's thumbnails; failures are reported, not fatal */
const attachThumbnails = async (
    options: SearchImagesToolOptions,
    set: SearchSet
): Promise<AttachedThumbnails> => {
    const { state, dependencies } = options;
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
            console.log(`[image-search] thumbnail ${candidate.id} failed: ${outcome.error}`);
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

/** Resolve or create the set this call talks about */
const resolveSet = async (
    options: SearchImagesToolOptions,
    args: { query: string | undefined; searchId: string | undefined; count: number }
): Promise<
    | { readonly ok: true; readonly set: SearchSet; readonly reused: boolean }
    | { readonly ok: false; readonly error: string }
> => {
    const { state, dependencies } = options;

    if (args.searchId !== undefined) {
        const set = state.searches.get(args.searchId);
        return set ? { ok: true, set, reused: false } : { ok: false, error: mediaToolErrors.unknownSet(args.searchId, state) };
    }

    const query = normalizeQuery(args.query ?? '');
    const existing = findExistingSet(state, query);
    if (existing) return { ok: true, set: existing, reused: true };

    const outcome = await dependencies.search({
        query,
        count: args.count,
        safesearch: dependencies.safesearch,
        engines: dependencies.engines,
        baseUrl: dependencies.baseUrl,
    });
    if (!outcome.ok) {
        return {
            ok: false,
            error: `${outcome.error}。图搜现在不可用：直接告诉用户没找到，不要用 generate_image 假装找到了。`,
        };
    }
    if (outcome.images.length === 0) {
        return {
            ok: false,
            error:
                `「${query}」一条可用的图都没有搜到。换个更短的关键词再试，或直接告诉用户没找到；` +
                '不要用 generate_image 假装找到了。',
        };
    }

    return { ok: true, set: newSearchSet(state, query, outcome.images), reused: false };
};

export const createSearchImagesTool = (options: SearchImagesToolOptions): ToolHandler => {
    const { state, dependencies } = options;

    return {
        definition: {
            name: SEARCH_IMAGES_TOOL_NAME,
            description: dependencies.canSeeImages ? DESCRIPTION_WITH_IMAGES : DESCRIPTION_TEXT_ONLY,
            inputSchema: INPUT_SCHEMA,
        },
        statusText: '🔍 正在找图…',
        chatAction: 'typing',
        execute: async (rawArgs) => {
            const parsed = parseSearchImagesArgs(rawArgs);
            if (!parsed.ok) return imageToolError(parsed.error);
            const args = parsed.args;

            const resolved = await resolveSet(options, args);
            if (!resolved.ok) return imageToolError(resolved.error);
            const { set, reused } = resolved;

            const unseenBefore = unseenCandidates(set).length;
            if (args.view === 'thumbnails' && unseenBefore === 0) {
                return imageToolError(mediaToolErrors.noMoreThumbnails(set.id));
            }

            const attachStartedAt = Date.now();
            const { attached, failed, modelImages } =
                args.view === 'thumbnails' && dependencies.canSeeImages
                    ? await attachThumbnails(options, set)
                    : { attached: [], failed: [], modelImages: [] };

            const windowIds = attached.map((candidate) => candidate.id);
            console.log(
                `[image-search] search=${set.id} view=${args.view} ` +
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
            });

            return {
                content,
                isError: false,
                images: [],
                ...(modelImages.length > 0 ? { modelImages } : {}),
                record: {
                    provider: 'mcp',
                    searchQueries: [`${SEARCH_IMAGES_TOOL_NAME}: ${set.id} 「${set.query}」`],
                    citations: [],
                },
            };
        },
    };
};

/** Reads thumbnails at most this big */
export const THUMBNAIL_LIMITS = {
    maxBytes: THUMBNAIL_MAX_BYTES,
    timeoutMs: THUMBNAIL_TIMEOUT_MS,
} as const;
