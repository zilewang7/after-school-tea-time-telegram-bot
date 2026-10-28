/**
 * send_sticker: put one real sticker from the fixed pack into the reply.
 *
 * The model picks by the pack's actual order or by what the picture shows.
 * The original filenames are deliberately not aliases: several of them name a
 * crown, a cat hat or angel wings that the drawing does not have (see the
 * catalog), and a model that trusts them sends the wrong picture.
 *
 * One visual attachment per reply: this shares the image tool's flag, so a
 * reply cannot send a picture and a sticker.
 */
import type { StickerDelivery } from '../../ai/types.js';
import type { ToolHandler, ToolModelImage, ToolResult } from '../../ai/tools/tool-types.js';
import {
    downloadStickerPreview,
    resolveSticker,
    StickerSetError,
    type StickerSetApi,
} from '../../services/sticker-set-service.js';
import { STICKER_CATALOG_TEXT } from '../../services/sticker-catalog.js';
import { imageToolError } from './image-tool-result.js';
import { padPackIndex, resolveStickerQuery } from './sticker-query.js';
import type { ReplyMediaState } from './reply-media-state.js';
import { SEND_STICKER_TOOL_NAME } from './tool-names.js';

const descriptionOf = (canPreview: boolean): string =>
    '从固定贴纸包 ColorfulHachimi 发一张贴纸（每条回复最多一张，不能和图片同时发）。' +
    'sticker 传包内序号或实际画面名称；序号是贴纸包里的实际顺序 01–72：\n' +
    STICKER_CATALOG_TEXT +
    '。\n' +
    '编号是包内顺序，不是原文件名编号；名称就是画面内容。' +
    (canPreview ? "拿不准先用 fetch_image(sticker='序号/名称') 看一眼再发。" : '') +
    '用户要“表情包/贴纸/发表情”时，先从这里挑；不要用 generate_image 画一张冒充，也不要用 send_image 发成图片。';

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        sticker: {
            type: 'string',
            description: "包内序号（01–72）或实际画面名称，如 '07'、'吃冰棒'、'st1'",
        },
    },
    required: ['sticker'],
};

export interface SendStickerToolOptions {
    readonly state: ReplyMediaState;
    readonly context: { readonly api: StickerSetApi; readonly signal: AbortSignal };
    readonly setName: string;
    /** fetch_image is offered: the description may tell the model to preview */
    readonly canPreview?: boolean;
}

const previewedPackIndexes = (state: ReplyMediaState): ReadonlySet<number> =>
    new Set(state.fetchedStickers.values());

/**
 * A rejected call leaves no other trace (the tool log keeps counts and errors
 * only), so the reason gets its own line: it is the only way to tell why a
 * reply shows `send_sticker x2`. The message quotes the model's own query, so
 * it is cut short and never widened to the whole arguments.
 */
const REJECTION_LOG_MAX_CHARS = 200;

const reject = (message: string): ToolResult => {
    console.warn(`[send_sticker] rejected: ${Array.from(message).slice(0, REJECTION_LOG_MAX_CHARS).join('')}`);
    return imageToolError(message);
};

export const createSendStickerTool = (options: SendStickerToolOptions): ToolHandler => {
    const { state, context, setName } = options;

    return {
        definition: {
            name: SEND_STICKER_TOOL_NAME,
            description: descriptionOf(options.canPreview === true),
            inputSchema: INPUT_SCHEMA,
        },
        statusText: '🩷 正在发贴纸…',
        chatAction: 'choose_sticker',
        execute: async (rawArgs, signal) => {
            if (state.hasReplyImage || state.hasReplySticker) {
                return reject('这条回复已经有一张图或贴纸了，每条回复只能发一个视觉附件。');
            }

            const raw = rawArgs.sticker;
            if (typeof raw !== 'string') {
                return reject("参数有误：sticker 要传字符串，如 '07' 或 '吃冰棒'");
            }

            const resolvedQuery = resolveStickerQuery(raw, state);
            if (!resolvedQuery.ok) return reject(resolvedQuery.error);
            const entry = resolvedQuery.entry;

            let fileId: string;
            try {
                const resolved = await resolveSticker(context.api, setName, entry);
                fileId = resolved.fileId;
            } catch (error) {
                const message =
                    error instanceof StickerSetError
                        ? error.message
                        : `贴纸包暂时不可用：${error instanceof Error ? error.message : String(error)}`;
                return reject(message);
            }

            state.hasReplySticker = true;

            // Show the model what it just sent, unless it previewed this one
            const alreadyPreviewed = previewedPackIndexes(state).has(entry.packIndex);
            let modelImages: ToolModelImage[] | undefined;
            if (!alreadyPreviewed) {
                try {
                    const preview = await downloadStickerPreview(
                        context.api,
                        setName,
                        entry,
                        'thumbnail',
                        signal
                    );
                    modelImages = [
                        {
                            data: preview.data,
                            mimeType: preview.mimeType,
                            caption: `你刚发出的贴纸：${padPackIndex(entry.packIndex)} ${entry.label}`,
                        },
                    ];
                } catch (error) {
                    console.warn('[send_sticker] preview download failed:', error);
                }
            }

            const duplicate =
                entry.duplicateOf === undefined
                    ? ''
                    : `（与 ${padPackIndex(entry.duplicateOf)} 相同）`;
            const sticker: StickerDelivery = {
                packIndex: entry.packIndex,
                label: entry.label,
                emoji: entry.emoji,
                fileId,
                fileUniqueId: entry.fileUniqueId,
            };

            return {
                content:
                    `已发出贴纸 ${padPackIndex(entry.packIndex)} ${entry.label}` +
                    `（包内第 ${padPackIndex(entry.packIndex)} 张${duplicate}）。`,
                isError: false,
                images: [],
                stickers: [sticker],
                ...(modelImages === undefined ? {} : { modelImages }),
                record: null,
            };
        },
    };
};
