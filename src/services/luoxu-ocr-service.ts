/**
 * OCR service backed by luoxu's MTProto client + PaddleOCR.
 *
 * Models that cannot look at pictures used to get nothing at all from an image:
 * the image part is filtered out and only "[sent a picture — not visible to
 * you]" survives, so a screenshot's content simply did not exist for them.
 * luoxu already OCRs every image it indexes, so we ask it for the text of one
 * message's images and keep that as a fallback.
 *
 * One /ocr call covers all four image sources of a message, so the result is
 * split across two stores:
 * - the message's own images (incl. rich-message photos) → messages.ocrText
 * - the link preview's thumbnail and Instant-View images → LinkPreviewCache.ocrText
 *   (URL-addressed, so every re-send of the same link reuses it)
 *
 * Unconfigured (LUOXU_OCR_URL empty) → everything here is a no-op.
 */
import { Message } from '../db/messageDTO.js';
import { LinkPreviewCache } from '../db/linkPreviewCacheDTO.js';

const luoxuBaseUrl = process.env.LUOXU_OCR_URL;

/** Whether luoxu-backed OCR is configured. */
export const isLuoxuOcrEnabled = (): boolean => Boolean(luoxuBaseUrl);

// Keep a wall of recognized text from crowding out the conversation. luoxu caps
// each image too; this caps the whole message.
const OCR_TEXT_LIMIT = 4000;

/** `which` values that belong to the link preview rather than the message */
const isPreviewItem = (which: string): boolean =>
    which === 'photo' || which === 'doc' || which.startsWith('page_');

interface LuoxuOcrItem {
    which: string;
    label: string;
    text: string;
}

interface LuoxuOcrResponse {
    status: string; // 'ok' | 'none' | 'disabled'
    items?: LuoxuOcrItem[];
}

const isLuoxuOcrResponse = (value: unknown): value is LuoxuOcrResponse =>
    typeof value === 'object' && value !== null && 'status' in value && typeof value.status === 'string';

const isOcrItem = (value: unknown): value is LuoxuOcrItem =>
    typeof value === 'object' &&
    value !== null &&
    'which' in value &&
    'text' in value &&
    typeof value.which === 'string' &&
    typeof value.text === 'string';

/**
 * Bot API supergroup/channel ids look like -100<channel_id>; luoxu (MTProto)
 * uses the bare channel_id. Returns null for chats luoxu can't address.
 */
const toLuoxuChannelId = (chatId: number): number | null => {
    if (chatId >= -1_000_000_000_000) return null;
    return -chatId - 1_000_000_000_000;
};

/** Join several images' text, each under its source label, and cap the whole. */
const renderOcrText = (items: LuoxuOcrItem[]): string | null => {
    const blocks = items
        .map((item) => item.text.trim())
        .filter((text) => text.length > 0);
    if (!blocks.length) return null;
    const joined = blocks.join('\n');
    return joined.length > OCR_TEXT_LIMIT
        ? `${joined.slice(0, OCR_TEXT_LIMIT)}…（已截断）`
        : joined;
};

const fetchOcrJson = async (channelId: number, messageId: number): Promise<LuoxuOcrResponse> => {
    const endpoint = `${luoxuBaseUrl}/ocr?g=${channelId}&id=${messageId}`;
    const res = await fetch(endpoint);
    if (!res.ok) {
        throw new Error(`luoxu /ocr HTTP ${res.status}`);
    }
    const payload: unknown = await res.json();
    if (!isLuoxuOcrResponse(payload)) {
        throw new Error('luoxu /ocr returned an unexpected payload');
    }
    return payload;
};

/** In-flight acquisitions by "chatId:messageId", so concurrent triggers share one call */
const inflightAcquisitions = new Map<string, Promise<void>>();

/**
 * OCR one message's images and store the text.
 *
 * `previewUrl` is the URL whose preview belongs to this message (same value
 * autoSave feeds to the link-preview cache); without it, preview/IV images are
 * recognized but have nowhere to be stored, so they are skipped.
 */
export const acquireOcr = (
    chatId: number,
    messageId: number,
    previewUrl: string | null
): Promise<void> => {
    const key = `${chatId}:${messageId}`;
    const inflight = inflightAcquisitions.get(key);
    if (inflight) return inflight;

    const acquisition = doAcquireOcr(chatId, messageId, previewUrl);
    inflightAcquisitions.set(key, acquisition);
    void acquisition.then(
        () => inflightAcquisitions.delete(key),
        () => inflightAcquisitions.delete(key)
    );
    return acquisition;
};

const doAcquireOcr = async (
    chatId: number,
    messageId: number,
    previewUrl: string | null
): Promise<void> => {
    if (!isLuoxuOcrEnabled()) return;

    const channelId = toLuoxuChannelId(chatId);
    if (channelId === null) return;

    const response = await fetchOcrJson(channelId, messageId);
    if (response.status !== 'ok') return;

    const items = (response.items ?? []).filter(isOcrItem);
    const messageText = renderOcrText(items.filter((item) => !isPreviewItem(item.which)));
    const previewText = renderOcrText(items.filter((item) => isPreviewItem(item.which)));

    if (messageText) {
        // Targeted update: the row is written concurrently by the media-bytes
        // save, and a full instance save would overwrite whatever it stored.
        await Message.update(
            { ocrText: messageText },
            { where: { chatId, messageId } }
        );
    }

    if (previewText && previewUrl) {
        // The preview row is created by the link-preview acquisition, which may
        // still be polling Telegram; only fill an existing row.
        const [updated] = await LinkPreviewCache.update(
            { ocrText: previewText },
            { where: { url: previewUrl } }
        );
        if (!updated) {
            console.log(`[luoxu-ocr] no preview row yet for ${previewUrl}, OCR text dropped`);
        }
    }

    console.log(
        `[luoxu-ocr] ${chatId}/${messageId}: ${items.length} image(s), ` +
        `message ${messageText ? `${messageText.length} chars` : 'none'}, ` +
        `preview ${previewText ? `${previewText.length} chars` : 'none'}`
    );
};

/** Render OCR text as the context part shown to a model that cannot see images. */
export const buildOcrFallbackPart = (ocrText: string): string =>
    `[system] 图中文字（OCR 自动识别，可能有错字或漏字，不要当作原文引用）：\n${ocrText}`;
