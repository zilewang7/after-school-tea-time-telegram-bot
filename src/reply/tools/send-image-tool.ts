/**
 * send_image: put a real, existing picture into the reply. The only way the
 * model gives the chat an image it did not draw — search candidates, pictures
 * it already read, a picture from the context, or any public image url.
 *
 * A reply may carry several pictures now: the tool may be called again and
 * each picture is appended to the reply's attachment list (one album when
 * there are several stills). The per-picture ids and limits live in
 * `ReplyMediaState`, so the model reads "the k-th of ten" instead of a
 * one-attachment rule.
 *
 * One call may also carry several pictures of the same source lane
 * (`search_ids`, `image_ids`, `urls`, `messages`): the batch form resolves them
 * in request order, each joins the reply and the reply's limits are checked per
 * picture, so one bad or over-quota picture does not drop the others. The
 * single form keeps its text, replay and trace unchanged.
 *
 * A GIF goes out as an animation (`sendAnimation`, see the delivery layer); the
 * model is shown its still frame, because a model reads a GIF as one frame
 * anyway and the still is all it needs to caption it.
 *
 * A picture the reply did not already show the model comes back as a
 * model-only image: the model has to see what it is about to send, or it
 * captions a candidate from its title and describes a picture the chat never
 * saw (live 1106627: text about a solo meme next to a group poster). An image
 * the model read with fetch_image, or one taken from a context message, is
 * already in the conversation — attaching it again would only double its
 * tokens.
 */
import type { GroundingCitation, GroundingData } from '../../ai/types.js';
import type { ToolHandler, ToolImage, ToolModelImage, ToolResult } from '../../ai/tools/tool-types.js';
import {
    MAX_REPLY_IMAGE_BYTES,
    MAX_REPLY_IMAGES,
    MAX_REPLY_IMAGE_TOTAL_BYTES,
} from '../../shared/reply-media.js';
import { imageToolError } from './image-tool-result.js';
import {
    formatSendBatchResult,
    formatSendResult,
    mediaToolErrors,
    type SendBatchLine,
} from './image-tool-text.js';
import {
    parseSendImageArgs,
    SEND_IMAGE_BATCH_MAX,
    type SendImageArgs,
    type SendImageBatchArgs,
    type SendImageSource,
} from './media-tool-args.js';
import {
    parseMediaRef,
    PRODUCTION_MEDIA_REF_DEPENDENCIES,
    resolveMediaRef,
    type MediaRef,
    type MediaRefDependencies,
    type ResolvedMediaBytes,
} from './media-ref-resolver.js';
import type { ReplyToolContext } from './reply-tool-context.js';
import { ONE_ATTACHMENT_PER_REPLY, type ReplyMediaState } from './reply-media-state.js';
import { SEND_IMAGE_TOOL_NAME } from './tool-names.js';
import { traceParts, traceUrl } from './tool-trace.js';

const DESCRIPTION =
    `发送图片到聊天（每回复最多 ${MAX_REPLY_IMAGES} 张，多张成相册，GIF 作动图）。` +
    `来源任选其一（批量用同类复数数组，≤${SEND_IMAGE_BATCH_MAX} 张、不可混类）。`;

const pluralSchema = (label: string) => ({
    type: 'array',
    items: { type: 'string' },
    minItems: 1,
    maxItems: SEND_IMAGE_BATCH_MAX,
    description: `批量${label}（≤${SEND_IMAGE_BATCH_MAX}，与单数互斥）`,
});

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        search_id: { type: 'string', description: "图搜候选（如 's3'）" },
        search_ids: pluralSchema('候选编号'),
        image_id: { type: 'string', description: '生成的 gN 或已读的 imgN' },
        image_ids: pluralSchema('gN/imgN'),
        message: { type: 'integer', minimum: 1, description: '上下文消息编号 #N' },
        image: { type: 'integer', minimum: 1, description: 'message 第几张图，默认1' },
        messages: {
            type: 'array',
            items: { type: 'integer', minimum: 1 },
            minItems: 1,
            maxItems: SEND_IMAGE_BATCH_MAX,
            description: `批量消息编号（≤${SEND_IMAGE_BATCH_MAX}，各取第1张）`,
        },
        url: { type: 'string', description: 'http(s) 图片直链' },
        urls: pluralSchema('图片直链'),
        caption: { type: 'string', description: '配文（批量时挂第1张）' },
        spoiler: {
            type: 'boolean',
            description: '给图片加 Telegram 剧透遮罩：聊天里先显示模糊，点开才看清',
        },
    },
};

/** The downloader and image loader the resolver needs; injectable for tests */
export type SendImageToolDependencies = MediaRefDependencies;

export interface SendImageToolOptions {
    readonly state: ReplyMediaState;
    readonly context: Pick<ReplyToolContext, 'chatId' | 'contextIndex' | 'signal'>;
    readonly dependencies?: SendImageToolDependencies;
}

/** The reference the parsed single-form arguments name; the parser guarantees exactly one */
const mediaRefOfArgs = (args: SendImageArgs): MediaRef | null => {
    if (args.imageId !== undefined) return parseMediaRef(args.imageId);
    if (args.message !== undefined) {
        return { kind: 'message', number: args.message, image: args.image ?? 1 };
    }
    if (args.searchId !== undefined) return parseMediaRef(args.searchId);
    if (args.url !== undefined) return { kind: 'url', url: args.url };
    return null;
};

/** The reference one plural source names; the lane is the argument's, not the id's */
const mediaRefOfSource = (source: SendImageSource): MediaRef => {
    switch (source.kind) {
        case 'candidate':
            return { kind: 'candidate', id: source.id };
        case 'image':
            return { kind: 'id', id: source.id };
        case 'url':
            return { kind: 'url', url: source.url };
        case 'message':
            return { kind: 'message', number: source.number, image: 1 };
    }
};

/** A source as the failure lines and the log name it; a url only by host + path */
const sourceNameOf = (source: SendImageSource): string => {
    switch (source.kind) {
        case 'candidate':
        case 'image':
            return source.id;
        case 'url':
            return traceUrl(source.url);
        case 'message':
            return `#${source.number}`;
    }
};

/** A picture's model-facing label: its id, or `#N` for a context message */
const sourceLabelOf = (resolved: ResolvedMediaBytes): string =>
    resolved.candidateId ??
    resolved.imageId ??
    resolved.generatedId ??
    (resolved.contextNumber === undefined ? 'url' : `#${resolved.contextNumber}`);

/** One line: untrusted titles must not forge another list item */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Cut by code points, so an emoji is never split in half */
const clip = (text: string, maxChars: number): string => {
    const characters = Array.from(text);
    return characters.length <= maxChars ? text : `${characters.slice(0, maxChars - 1).join('')}…`;
};

/** The model has to see the picture it just sent, or it captions a guess */
const modelImageCaptionOf = (resolved: ResolvedMediaBytes, animated: boolean): string =>
    `你刚发出的图片 ${sourceLabelOf(resolved)}${
        resolved.title === undefined ? '' : ` · ${resolved.title}`
    }${animated ? '（动图，这里是它的第一帧）' : ''}`;

/** One added picture as the batch result lists it */
const batchLineOf = (source: SendImageSource, resolved: ResolvedMediaBytes): SendBatchLine => {
    const animated = resolved.mimeType === 'image/gif';
    switch (source.kind) {
        case 'candidate': {
            const title = resolved.title === undefined ? '' : oneLine(resolved.title);
            return {
                label: title === '' ? `候选 ${source.id}` : `候选 ${source.id}「${clip(title, 40)}」`,
                animated,
            };
        }
        case 'image':
            return {
                label: resolved.generatedId === undefined ? `已读图 ${source.id}` : `本次生成的图 ${source.id}`,
                animated,
            };
        case 'url':
            return { label: traceUrl(source.url), animated };
        case 'message':
            return { label: `#${source.number} 的图`, animated };
    }
};

/** A value listed twice as the batch result names it: a url by host + path only */
const duplicateNameOf = (kind: SendImageSource['kind'], value: string): string => {
    switch (kind) {
        case 'url':
            return traceUrl(value);
        case 'message':
            return `#${value}`;
        case 'candidate':
        case 'image':
            return value;
    }
};

interface SendBatchTally {
    readonly lines: SendBatchLine[];
    readonly failures: string[];
    readonly images: ToolImage[];
    readonly modelImages: ToolModelImage[];
    readonly citations: GroundingCitation[];
    readonly searchQueries: string[];
    /** 1-based reply position of the first picture added here; 0 = none */
    firstIndex: number;
    /** The source that added that first picture */
    firstAddedName: string;
}

const emptySendBatchTally = (): SendBatchTally => ({
    lines: [],
    failures: [],
    images: [],
    modelImages: [],
    citations: [],
    searchQueries: [],
    firstIndex: 0,
    firstAddedName: '',
});

/** One resolved picture into the reply and the answer */
const absorbBatchPicture = (
    tally: SendBatchTally,
    state: ReplyMediaState,
    source: SendImageSource,
    resolved: ResolvedMediaBytes,
    caption: string,
    spoiler: boolean
): void => {
    const position = state.imageCount + 1;
    state.imageCount = position;
    state.imageBytes += resolved.data.length;
    state.hasReplyImage = true;
    if (tally.firstIndex === 0) {
        tally.firstIndex = position;
        tally.firstAddedName = sourceNameOf(source);
    }

    const animated = resolved.mimeType === 'image/gif';
    // One album carries one caption, on its first picture
    const pictureCaption = tally.lines.length === 0 ? caption : '';
    tally.images.push({
        data: resolved.data,
        mimeType: resolved.mimeType,
        ...(pictureCaption === '' ? {} : { caption: pictureCaption }),
        ...(spoiler ? { spoiler: true } : {}),
    });
    if (
        resolved.imageId === undefined &&
        resolved.generatedId === undefined &&
        resolved.contextNumber === undefined
    ) {
        tally.modelImages.push({
            data: resolved.still.data,
            mimeType: resolved.still.mimeType,
            caption: modelImageCaptionOf(resolved, animated),
        });
    }
    tally.lines.push(batchLineOf(source, resolved));
    if (resolved.sourcePage !== '') {
        tally.citations.push({
            uri: resolved.sourcePage,
            ...(resolved.title === undefined ? {} : { title: resolved.title }),
        });
        tally.searchQueries.push(`${SEND_IMAGE_TOOL_NAME}: ${sourceLabelOf(resolved)}`);
    }
};

const uniqueCitations = (citations: readonly GroundingCitation[]): GroundingCitation[] => {
    const seen = new Set<string>();
    return citations.filter((citation) => {
        if (seen.has(citation.uri)) return false;
        seen.add(citation.uri);
        return true;
    });
};

/** The argument summary of a batch: the source list, short enough for a log line */
const batchTraceArgument = (sources: readonly SendImageSource[]): string => {
    const names = sources.map((source) => clip(sourceNameOf(source), 20));
    const first = names[0] ?? '';
    return names.length > 3 ? `${first} 等 ${names.length} 张` : names.join(',');
};

/**
 * Several pictures of one lane in one call: resolve them in request order and
 * add each one the reply still has room for. A picture that fails or does not
 * fit is named on its own line; the rest of the call goes on.
 */
const runSendImageBatch = async (
    batch: SendImageBatchArgs,
    options: SendImageToolOptions,
    dependencies: MediaRefDependencies
): Promise<ToolResult> => {
    const { state, context } = options;
    const tally = emptySendBatchTally();
    let stopped = false;

    for (const source of batch.sources) {
        const name = sourceNameOf(source);
        if (stopped || context.signal.aborted) {
            stopped = true;
            tally.failures.push(`${name}：回复已停止，没有加入。`);
            continue;
        }
        const remaining = MAX_REPLY_IMAGES - state.imageCount;
        if (remaining <= 0) {
            tally.failures.push(`${name}：${mediaToolErrors.imageQuotaLeft(remaining, MAX_REPLY_IMAGES)}`);
            continue;
        }
        const resolved = await resolveMediaRef(mediaRefOfSource(source), {
            state,
            chatId: context.chatId,
            contextIndex: context.contextIndex,
            signal: context.signal,
            dependencies,
        });
        if (!resolved.ok) {
            tally.failures.push(`${name}：${resolved.error}`);
            continue;
        }
        if (resolved.data.length > MAX_REPLY_IMAGE_BYTES) {
            tally.failures.push(
                `${name}：${mediaToolErrors.tooLarge(MAX_REPLY_IMAGE_BYTES / 1024 / 1024)}`
            );
            continue;
        }
        if (state.imageBytes + resolved.data.length > MAX_REPLY_IMAGE_TOTAL_BYTES) {
            tally.failures.push(
                `${name}：${mediaToolErrors.imageTotalTooLarge(MAX_REPLY_IMAGE_TOTAL_BYTES / 1024 / 1024)}`
            );
            continue;
        }
        absorbBatchPicture(tally, state, source, resolved, batch.caption, batch.spoiler);
    }

    const content = formatSendBatchResult({
        firstIndex: tally.firstIndex,
        lastIndex: tally.firstIndex === 0 ? 0 : tally.firstIndex + tally.lines.length - 1,
        limit: MAX_REPLY_IMAGES,
        lines: tally.lines,
        failures: tally.failures,
        skippedDuplicates: batch.skippedDuplicates.map((value) => duplicateNameOf(batch.kind, value)),
    });
    const citations = uniqueCitations(tally.citations);
    const searchQueries = [...new Set(tally.searchQueries)];
    const record: GroundingData | null =
        citations.length === 0 && searchQueries.length === 0
            ? null
            : {
                  provider: 'mcp',
                  searchQueries,
                  ...(citations.length === 0 ? {} : { citations }),
              };
    const firstFailure = tally.failures[0] ?? '';
    const traceResult =
        tally.firstIndex === 0
            ? traceParts(`这 ${batch.sources.length} 张都没加入`, clip(oneLine(firstFailure), 28))
            : traceParts(
                  tally.lines.length === 1
                      ? tally.firstAddedName
                      : `${tally.firstAddedName} 等 ${tally.lines.length} 张`,
                  tally.failures.length > 0 ? `${tally.failures.length} 项失败` : null
              );

    return {
        content,
        isError: tally.lines.length === 0,
        images: tally.images,
        ...(tally.modelImages.length === 0 ? {} : { modelImages: tally.modelImages }),
        record,
        trace: { argument: batchTraceArgument(batch.sources), result: traceResult },
    };
};

export const createSendImageTool = (options: SendImageToolOptions): ToolHandler => {
    const { state, context } = options;
    const dependencies = options.dependencies ?? PRODUCTION_MEDIA_REF_DEPENDENCIES;

    return {
        definition: {
            name: SEND_IMAGE_TOOL_NAME,
            description: DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
        },
        statusText: '📤 正在发图…',
        chatAction: 'upload_photo',
        execute: async (rawArgs) => {
            // Stickers, files and cards keep their one-attachment-per-reply rule;
            // pictures among themselves are a list now
            if (state.hasReplySticker || state.hasReplyFile || state.hasReplyWidget) {
                return imageToolError(ONE_ATTACHMENT_PER_REPLY);
            }

            const parsed = parseSendImageArgs(rawArgs);
            if (!parsed.ok) return imageToolError(parsed.error);
            const args = parsed.args;
            // The batch form resolves each picture on its own: one failure does
            // not drop the rest of the call
            if (args.batch !== undefined) return runSendImageBatch(args.batch, options, dependencies);

            const ref = mediaRefOfArgs(args);
            if (ref === null) return imageToolError(mediaToolErrors.noImageSource);

            const resolved = await resolveMediaRef(ref, {
                state,
                chatId: context.chatId,
                contextIndex: context.contextIndex,
                ...(context.signal === undefined ? {} : { signal: context.signal }),
                dependencies,
            });
            if (!resolved.ok) return imageToolError(resolved.error);

            // The picture joins the reply's attachment list; the limits are the
            // reply's, not this call's
            const nextCount = state.imageCount + 1;
            if (nextCount > MAX_REPLY_IMAGES) {
                return imageToolError(mediaToolErrors.imageLimitReached(MAX_REPLY_IMAGES));
            }
            if (resolved.data.length > MAX_REPLY_IMAGE_BYTES) {
                return imageToolError(mediaToolErrors.tooLarge(MAX_REPLY_IMAGE_BYTES / 1024 / 1024));
            }
            const nextBytes = state.imageBytes + resolved.data.length;
            if (nextBytes > MAX_REPLY_IMAGE_TOTAL_BYTES) {
                return imageToolError(
                    mediaToolErrors.imageTotalTooLarge(MAX_REPLY_IMAGE_TOTAL_BYTES / 1024 / 1024)
                );
            }

            state.imageCount = nextCount;
            state.imageBytes = nextBytes;
            state.hasReplyImage = true;

            const animated = resolved.mimeType === 'image/gif';
            const note = resolved.note;
            const label = sourceLabelOf(resolved);
            // The log names a url by its host only: a query string can carry a secret
            const traceArgument = args.url === undefined ? label : traceUrl(args.url);
            const captionChars = Array.from(args.caption.trim()).length;
            const traceResult = traceParts(
                `第 ${state.imageCount}/${MAX_REPLY_IMAGES} 张`,
                animated ? '动图' : null,
                captionChars > 0 ? `配文 ${captionChars} 字` : null
            );

            return {
                content: formatSendResult({
                    index: state.imageCount,
                    limit: MAX_REPLY_IMAGES,
                    ...(resolved.candidateId === undefined ? {} : { candidateId: resolved.candidateId }),
                    ...(resolved.imageId === undefined ? {} : { imageId: resolved.imageId }),
                    ...(resolved.generatedId === undefined ? {} : { generatedId: resolved.generatedId }),
                    ...(resolved.contextNumber === undefined
                        ? {}
                        : { contextNumber: resolved.contextNumber }),
                    ...(animated ? { animated: true } : {}),
                    ...(note === undefined ? {} : { note }),
                    ...(resolved.sourcePage === '' ? {} : { sourcePage: resolved.sourcePage }),
                }),
                isError: false,
                images: [
                    {
                        data: resolved.data,
                        mimeType: resolved.mimeType,
                        ...(args.caption ? { caption: args.caption } : {}),
                        ...(args.spoiler ? { spoiler: true } : {}),
                    },
                ],
                ...(resolved.imageId === undefined &&
                resolved.generatedId === undefined &&
                resolved.contextNumber === undefined
                    ? {
                          modelImages: [
                              {
                                  data: resolved.still.data,
                                  mimeType: resolved.still.mimeType,
                                  caption: modelImageCaptionOf(resolved, animated),
                              },
                          ],
                      }
                    : {}),
                record:
                    resolved.sourcePage === ''
                        ? null
                        : {
                              provider: 'mcp',
                              searchQueries: [
                                  `${SEND_IMAGE_TOOL_NAME}: ${
                                      resolved.candidateId ?? resolved.imageId ?? resolved.contextNumber ?? 'url'
                                  }`,
                              ],
                              citations: [
                                  {
                                      uri: resolved.sourcePage,
                                      ...(resolved.title === undefined ? {} : { title: resolved.title }),
                                  },
                              ],
                          },
                trace: { argument: traceArgument, result: traceResult },
            };
        },
    };
};
