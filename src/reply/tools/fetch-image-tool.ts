/**
 * fetch_image: pull pictures into the model's context without sending them
 * anywhere. The companion to search_images for "let me look at that one
 * properly" — full size, OCR, or as a reference for generate_image.
 *
 * One source per call reads exactly one picture; the plural arguments
 * (`search_ids`, `urls`, `histories`, `avatars`, `stickers`) read up to
 * FETCH_BATCH_MAX of the same lane in one call, with their downloads running
 * side by side (see fetch-image-batch.ts). A single read keeps the text it has
 * always had.
 *
 * A GIF is different from a still picture here: handed over as `image/gif` a
 * model reads only its first frame (verified 2026-10-23 — `videoMetadata.fps`
 * is ignored for an image part), so the animation is re-encoded to mp4 and
 * replayed as a video part where the platform supports it. The chat still gets
 * the original GIF when the model sends it.
 *
 * Reading the same image twice returns the first read: the bytes are already in
 * the conversation, and only the id is needed for send_image / generate_image.
 */
import type { ToolCallLink } from '../../ai/types.js';
import type { ToolCallTrace, ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import { fetchImageBytes } from '../../services/image-fetch-service.js';
import type { HistoryImageOptions } from './history-image.js';
import type { HistoryState } from './history-state.js';
import { historyRefLinks } from './history-tool-shared.js';
import type { AvatarLaneOptions } from './avatar-lane.js';
import type { StickerSetApi } from '../../services/sticker-set-service.js';
import { transcodeVideoToMp4 } from '../../services/tgs-client.js';
import { excerptOf, type FetchImageDependencies } from './fetch-image-lane-types.js';
import { readFetchSource, type FetchReadContext } from './fetch-image-lanes.js';
import { runFetchImageBatch } from './fetch-image-batch.js';
import { imageToolError } from './image-tool-result.js';
import { FETCH_BATCH_MAX, parseFetchImageArgs } from './media-tool-args.js';
import { nextFetchedImageId, nextFetchedStickerId, type ReplyMediaState } from './reply-media-state.js';
import { FETCH_IMAGE_TOOL_NAME } from './tool-names.js';
import { traceRef, traceText, traceUrl } from './tool-trace.js';

export type { FetchImageDependencies } from './fetch-image-lane-types.js';

const DESCRIPTION =
    '将图片加载到本轮上下文（仅模型可见）用于看细节/OCR/生图参考；返回 imgN（贴纸 stN），GIF 转视频。';

/** The batch sentence only names the plural arguments this turn actually offers */
const batchDescriptionOf = (hasSticker: boolean, hasHistory: boolean, hasAvatar: boolean): string => {
    const names = [
        'search_ids',
        'urls',
        ...(hasHistory ? ['histories'] : []),
        ...(hasSticker ? ['stickers'] : []),
        ...(hasAvatar ? ['avatars'] : []),
    ];
    return `批量同类传数组（${names.join('/')}，≤${FETCH_BATCH_MAX}）。`;
};

const HISTORY_DESCRIPTION = 'history/histories 读归档图（image 选第几张）；';

const STICKER_DESCRIPTION = 'sticker/stickers 预览贴纸；';

const AVATAR_DESCRIPTION = 'avatar/avatars 读头像（me/chat/#N/@user/uid/t.me）。';

const pluralSchema = (label: string) => ({
    type: 'array',
    items: { type: 'string' },
    minItems: 1,
    maxItems: FETCH_BATCH_MAX,
    description: `批量${label}（≤${FETCH_BATCH_MAX}）`,
});

const inputSchemaOf = (hasSticker: boolean, hasHistory: boolean, hasAvatar: boolean) => ({
    type: 'object',
    properties: {
        ...(hasHistory
            ? {
                  history: { type: 'string', description: '归档 hN 或 t.me 链接' },
                  image: {
                      type: 'integer',
                      minimum: 1,
                      description: 'history 第几张图（默认1）',
                  },
                  histories: pluralSchema('归档引用'),
              }
            : {}),
        search_id: { type: 'string', description: '候选 sN' },
        search_ids: pluralSchema('候选'),
        image_id: { type: 'string', description: '已读 imgN' },
        url: { type: 'string', description: 'http(s) 图片直链' },
        urls: pluralSchema('图片直链'),
        ...(hasSticker
            ? {
                  sticker: { type: 'string', description: '贴纸序号 01–72/画面名/目录行' },
                  stickers: pluralSchema('贴纸'),
              }
            : {}),
        ...(hasAvatar
            ? {
                  avatar: { type: 'string', description: 'me/chat/#N/@user/uid/t.me' },
                  avatars: pluralSchema('头像'),
              }
            : {}),
        view: {
            type: 'string',
            enum: ['original', 'thumbnail'],
            description: 'original（默认）/ thumbnail',
        },
    },
});

const hasNonEmptyString = (value: unknown): boolean =>
    typeof value === 'string' && value.trim() !== '';

const hasNonEmptyStringArray = (value: unknown): boolean =>
    Array.isArray(value) && value.some((item) => typeof item === 'string' && item.trim() !== '');

const NON_STICKER_SINGULAR_KEYS = ['search_id', 'image_id', 'url', 'history', 'avatar'] as const;
const NON_STICKER_PLURAL_KEYS = ['search_ids', 'urls', 'histories', 'avatars'] as const;

const isStickerOnlyFetch = (args: Readonly<Record<string, unknown>>): boolean => {
    const hasSticker = hasNonEmptyString(args.sticker) || hasNonEmptyStringArray(args.stickers);
    if (!hasSticker) return false;
    const hasOtherSingular = NON_STICKER_SINGULAR_KEYS.some((key) => hasNonEmptyString(args[key]));
    const hasOtherPlural = NON_STICKER_PLURAL_KEYS.some((key) => hasNonEmptyStringArray(args[key]));
    return !hasOtherSingular && !hasOtherPlural;
};

/** GIF → mp4, the only shape in which a model sees an animation move */
const transcodeGifToMp4 = async (gif: Buffer): Promise<Buffer | null> => {
    const result = await transcodeVideoToMp4(gif, 'image/gif');
    return result?.data ?? null;
};

export interface FetchImageToolOptions {
    readonly state: ReplyMediaState;
    readonly dependencies: FetchImageDependencies;
    /** The platform replays an mp4 inside a tool result (Gemini today) */
    readonly canSeeAnimated?: boolean;
    /** Sticker previews; absent = this turn has no sticker tool */
    readonly sticker?: { readonly setName: string; readonly api: StickerSetApi };
    /** The archive lane; absent = this turn has no history tools */
    readonly history?: HistoryImageOptions;
    /** The avatar lane; absent = this turn cannot read avatars */
    readonly avatar?: AvatarLaneOptions;
}

/** Production wiring; tests pass their own */
export const PRODUCTION_FETCH_DEPENDENCIES: FetchImageDependencies = {
    fetchImage: fetchImageBytes,
    transcodeAnimation: transcodeGifToMp4,
};

/**
 * A rejected call leaves no other trace (the tool log keeps counts and errors
 * only), so the reason gets its own line — the rule send_sticker already
 * follows. The request is named by the one argument the model picked, and a
 * url only by its host: a query string can carry a secret.
 */
const REJECTION_LOG_MAX_CHARS = 200;

const hostOfUrl = (raw: string): string => {
    try {
        return new URL(raw).hostname;
    } catch {
        return '<无法解析的地址>';
    }
};

const textArgOf = (args: Readonly<Record<string, unknown>>, key: string): string | undefined => {
    const value = args[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
};

const textListArgOf = (args: Readonly<Record<string, unknown>>, key: string): readonly string[] | undefined => {
    const value = args[key];
    if (!Array.isArray(value)) return undefined;
    const items = value.filter((item): item is string => typeof item === 'string').map((item) => item.trim());
    return items.length === 0 ? undefined : items;
};

/** Every url in a log line by host + path: a query string can carry a secret */
const URL_IN_TEXT = /https?:\/\/[^\s，。；、）】」』]+/g;
const logSafeText = (text: string): string => text.replace(URL_IN_TEXT, (url) => traceUrl(url));

/** `6 项：s1,s2,s3…`: the count first, so the log keeps it after truncation */
const shortList = (values: readonly string[], render: (value: string) => string): string => {
    const shown = values
        .slice(0, 3)
        .map((value) => excerptOf(render(value), 16))
        .join(',');
    return values.length > 3 ? `${values.length} 项：${shown}…` : shown;
};

/** `· 第2张` when the call picked one picture of an archived message */
const imageIndexSuffixOf = (args: Readonly<Record<string, unknown>>): string => {
    const image = args['image'];
    return typeof image === 'number' && Number.isInteger(image) && image > 1 ? ` · 第${image}张` : '';
};

/**
 * The argument summary of one call: the source lane the model picked, in the
 * same short form the log shows. A url is only its host + path (a query string
 * can carry a secret).
 */
export const describeFetchImageArgument = (args: Readonly<Record<string, unknown>>): string | null => {
    const stickers = textListArgOf(args, 'stickers');
    if (stickers !== undefined) return shortList(stickers, traceText);
    const sticker = textArgOf(args, 'sticker');
    if (sticker !== undefined) return traceText(sticker);
    const histories = textListArgOf(args, 'histories');
    if (histories !== undefined) return shortList(histories, traceRef);
    const history = textArgOf(args, 'history');
    if (history !== undefined) return `${traceRef(history)}${imageIndexSuffixOf(args)}`;
    const avatars = textListArgOf(args, 'avatars');
    if (avatars !== undefined) return `${shortList(avatars, traceText)} 头像`;
    const avatar = textArgOf(args, 'avatar');
    if (avatar !== undefined) return `${traceText(avatar)} 头像`;
    const searchIds = textListArgOf(args, 'search_ids');
    if (searchIds !== undefined) return shortList(searchIds, traceText);
    const searchId = textArgOf(args, 'search_id');
    if (searchId !== undefined) return traceText(searchId);
    const imageId = textArgOf(args, 'image_id');
    if (imageId !== undefined) return traceText(imageId);
    const urls = textListArgOf(args, 'urls');
    if (urls !== undefined) return shortList(urls, traceUrl);
    const url = textArgOf(args, 'url');
    if (url !== undefined) return traceUrl(url);
    return null;
};

/**
 * The clickable spans of a fetch_image call's `hN` refs (design 2026-1120-1617):
 * each opens the archived message it names. Refs of another kind (t.me links)
 * and turns without an archive lane produce nothing.
 */
export const describeFetchImageLinks = (
    args: Readonly<Record<string, unknown>>,
    state: HistoryState | undefined
): readonly ToolCallLink[] => {
    if (state === undefined) return [];
    const refs = [...(textListArgOf(args, 'histories') ?? [])];
    const history = textArgOf(args, 'history');
    if (history !== undefined) refs.push(history);
    return historyRefLinks(state, refs);
};

export const describeFetchImageRequest = (args: Readonly<Record<string, unknown>>): string => {
    const textOf = (key: string): string | undefined => textArgOf(args, key);
    const listOf = (key: string): readonly string[] | undefined => textListArgOf(args, key);
    const stickers = listOf('stickers');
    if (stickers !== undefined) return `stickers=${stickers.join(',')}`;
    const sticker = textOf('sticker');
    if (sticker !== undefined) return `sticker=${sticker}`;
    const histories = listOf('histories');
    if (histories !== undefined) return `histories=${histories.map(traceRef).join(',')}`;
    const history = textOf('history');
    if (history !== undefined) return `history=${history}`;
    const avatars = listOf('avatars');
    if (avatars !== undefined) return `avatars=${avatars.map(traceRef).join(',')}`;
    const avatar = textOf('avatar');
    if (avatar !== undefined) return `avatar=${avatar}`;
    const searchIds = listOf('search_ids');
    if (searchIds !== undefined) return `search_ids=${searchIds.join(',')}`;
    const searchId = textOf('search_id');
    if (searchId !== undefined) return `search_id=${searchId}`;
    const imageId = textOf('image_id');
    if (imageId !== undefined) return `image_id=${imageId}`;
    const urls = listOf('urls');
    if (urls !== undefined) return `urls=${urls.map(hostOfUrl).join(',')}`;
    const url = textOf('url');
    if (url !== undefined) return `url=${hostOfUrl(url)}`;
    return '没有取图来源';
};

/** The one line a rejection leaves behind; pure so a test can pin its shape */
export const fetchImageRejectionLine = (request: string, message: string): string =>
    Array.from(`${request} → ${message}`.replace(/\s+/g, ' '))
        .slice(0, REJECTION_LOG_MAX_CHARS)
        .join('');

const reject = (request: string, message: string, traceArgument: string | null): ToolResult => {
    console.warn(`[fetch_image] rejected: ${fetchImageRejectionLine(logSafeText(request), logSafeText(message))}`);
    return imageToolError(
        message,
        traceArgument === null ? undefined : { argument: traceArgument }
    );
};

export const createFetchImageTool = (options: FetchImageToolOptions): ToolHandler => {
    const { state, dependencies } = options;
    const canSeeAnimated = options.canSeeAnimated === true;
    const descriptionOf = (): string => {
        const parts = [
            DESCRIPTION,
            batchDescriptionOf(options.sticker !== undefined, options.history !== undefined, options.avatar !== undefined),
        ];
        if (options.history !== undefined) parts.push(HISTORY_DESCRIPTION);
        if (options.sticker !== undefined) parts.push(STICKER_DESCRIPTION);
        if (options.avatar !== undefined) parts.push(AVATAR_DESCRIPTION);
        return parts.join('');
    };

    return {
        definition: {
            name: FETCH_IMAGE_TOOL_NAME,
            description: descriptionOf(),
            inputSchema: inputSchemaOf(
                options.sticker !== undefined,
                options.history !== undefined,
                options.avatar !== undefined
            ),
        },
        statusText: (args) => (isStickerOnlyFetch(args) ? '🩷 正在挑选贴纸…' : '🖼 正在读图…'),
        chatAction: 'typing',
        execute: async (rawArgs, signal) => {
            const request = describeFetchImageRequest(rawArgs);
            const traceArgument = describeFetchImageArgument(rawArgs);
            const traceLinks = describeFetchImageLinks(rawArgs, options.history?.state);
            const traceOf = (result: string): ToolCallTrace => ({
                ...(traceArgument === null ? {} : { argument: traceArgument }),
                ...(traceLinks.length === 0 ? {} : { links: traceLinks }),
                result,
            });
            const parsed = parseFetchImageArgs(rawArgs);
            if (!parsed.ok) return reject(request, parsed.error, traceArgument);
            const args = parsed.args;
            const context: FetchReadContext = {
                state,
                dependencies,
                canSeeAnimated,
                view: args.view,
                imageIndex: args.image,
                signal,
                ...(options.sticker === undefined ? {} : { sticker: options.sticker }),
                ...(options.history === undefined ? {} : { history: options.history }),
                ...(options.avatar === undefined ? {} : { avatar: options.avatar }),
            };

            if (args.sources.length > 1 || args.skippedDuplicates.length > 0) {
                const batch = await runFetchImageBatch(args.sources, args.skippedDuplicates, context);
                if (batch.failures.length > 0 && signal.aborted !== true) {
                    // A batch that partly failed has no rejected call to log; the
                    // first unread item is what an operator needs to see. A stop
                    // is not a failure worth a warning.
                    console.warn(
                        `[fetch_image] ${batch.failures.length} 项没读出来：` +
                            fetchImageRejectionLine(logSafeText(request), logSafeText(batch.failures[0] ?? ''))
                    );
                }
                return {
                    content: batch.content,
                    isError: batch.isError,
                    images: [],
                    ...(batch.modelImages.length === 0 ? {} : { modelImages: batch.modelImages }),
                    record: batch.record,
                    trace: traceOf(batch.traceResult),
                };
            }

            const source = args.sources[0];
            if (source === undefined) return reject(request, '没有取图来源', traceArgument);
            const outcome = await readFetchSource(source, context);
            if (!outcome.ok) return reject(request, outcome.error, traceArgument);
            if (outcome.status === 'reuse') {
                return {
                    content: outcome.content,
                    isError: false,
                    images: [],
                    record: null,
                    trace: traceOf(outcome.traceResult),
                };
            }
            const { read } = outcome;
            const id = read.kind === 'sticker' ? nextFetchedStickerId(state) : nextFetchedImageId(state);
            read.register(id);
            const materialized = read.materialize(id);
            return {
                content: materialized.content,
                isError: false,
                images: [],
                modelImages: [{ data: read.data, mimeType: read.mimeType, caption: materialized.caption }],
                record:
                    read.citation === undefined
                        ? null
                        : {
                              provider: 'mcp',
                              searchQueries: read.searchQuery === undefined ? [] : [read.searchQuery],
                              citations: [read.citation],
                          },
                trace: traceOf(materialized.traceResult),
            };
        },
    };
};
