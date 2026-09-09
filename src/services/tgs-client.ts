/**
 * Client for the tgs-converter microservice.
 * Converts Telegram .tgs animated stickers to .webm so multimodal models can
 * process them. Returns null on any failure (caller falls back to thumbnail).
 */

const TGS_CONVERTER_URL = process.env.TGS_CONVERTER_URL;
const CONVERT_TIMEOUT_MS = 30000;
const NORMALIZE_TIMEOUT_MS = 30000;
const EMOJI_TIMEOUT_MS = 30000;
const MAX_EMOJI_ATLAS_ITEMS = 8;
const MAX_EMOJI_PREVIEW_BYTES = 1024 * 1024;
const MAX_EMOJI_ATLAS_BYTES = 512 * 1024;

const createTimedController = (
    timeoutMs: number,
    parentSignal?: AbortSignal
): { signal: AbortSignal; dispose: () => void } => {
    const controller = new AbortController();
    const abortFromParent = (): void => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('request timed out')), timeoutMs);
    return {
        signal: controller.signal,
        dispose: () => {
            clearTimeout(timer);
            parentSignal?.removeEventListener('abort', abortFromParent);
        },
    };
};

export interface ConvertedTgs {
    data: Buffer;
    mime: string;
}

export interface NormalizedVideo {
    data: Buffer;
    mimeType: string;
    normalized: boolean;
}

export interface CustomEmojiPreviewInput {
    data: Buffer;
    mimeType: string;
    animated: boolean;
    video: boolean;
    needsRepainting: boolean;
}

export interface CustomEmojiAtlasItem {
    label: string;
    image: Buffer;
}

export interface CustomEmojiImage {
    data: Buffer;
    mimeType: 'image/png';
}

/**
 * Convert a .tgs buffer to .webm via the converter service.
 * Returns null if the service is unconfigured, unreachable, or fails.
 */
export const convertTgsToWebm = async (tgs: Buffer): Promise<ConvertedTgs | null> => {
    if (!TGS_CONVERTER_URL) {
        console.warn('[tgs-client] TGS_CONVERTER_URL not set, skipping conversion');
        return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONVERT_TIMEOUT_MS);

    try {
        // Direct call on the docker network — no Telegram proxy agent here.
        const res = await fetch(`${TGS_CONVERTER_URL}/convert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: tgs,
            signal: controller.signal,
        });

        if (!res.ok) {
            console.error(`[tgs-client] convert failed: HTTP ${res.status}`);
            return null;
        }

        const arrayBuffer = await res.arrayBuffer();
        return { data: Buffer.from(arrayBuffer), mime: 'video/webm' };
    } catch (error) {
        console.error('[tgs-client] convert request error:', error instanceof Error ? error.message : error);
        return null;
    } finally {
        clearTimeout(timer);
    }
};

/**
 * Send a video through the converter's normalize endpoint: if the clip is
 * shorter than ~1s, it is looped/padded into a Gemini-compatible MP4; otherwise
 * the bytes are returned unchanged. Returns null on any failure.
 */
export const normalizeShortVideo = async (
    video: Buffer,
    mimeType: string
): Promise<NormalizedVideo | null> => {
    if (!TGS_CONVERTER_URL) {
        console.warn('[tgs-client] TGS_CONVERTER_URL not set, skipping video normalization');
        return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NORMALIZE_TIMEOUT_MS);

    try {
        const res = await fetch(`${TGS_CONVERTER_URL}/normalize-video?mime=${encodeURIComponent(mimeType)}`, {
            method: 'POST',
            headers: { 'Content-Type': mimeType },
            body: video,
            signal: controller.signal,
        });

        if (!res.ok) {
            console.error(`[tgs-client] normalize failed: HTTP ${res.status}`);
            return null;
        }

        const arrayBuffer = await res.arrayBuffer();
        const responseMime = res.headers.get('content-type')?.split(';')[0] ?? mimeType;
        return {
            data: Buffer.from(arrayBuffer),
            mimeType: responseMime,
            normalized: res.headers.get('x-normalized') === '1',
        };
    } catch (error) {
        console.error('[tgs-client] normalize request error:', error instanceof Error ? error.message : error);
        return null;
    } finally {
        clearTimeout(timer);
    }
};

const readPngResponse = async (
    response: Response,
    context: string,
    maxBytes: number
): Promise<CustomEmojiImage | null> => {
    if (!response.ok) {
        console.error(`[tgs-client] ${context} failed: HTTP ${response.status}`);
        return null;
    }
    const mimeType = response.headers.get('content-type')?.split(';')[0];
    if (mimeType !== 'image/png') {
        console.error(`[tgs-client] ${context} returned unexpected content type: ${mimeType ?? 'missing'}`);
        return null;
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        console.error(`[tgs-client] ${context} response exceeds ${maxBytes} bytes`);
        return null;
    }
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength > maxBytes) {
        console.error(`[tgs-client] ${context} returned an empty or oversized body`);
        return null;
    }
    return { data: Buffer.from(arrayBuffer), mimeType: 'image/png' };
};

export const createCustomEmojiPreview = async (
    input: CustomEmojiPreviewInput,
    signal?: AbortSignal
): Promise<CustomEmojiImage | null> => {
    if (!TGS_CONVERTER_URL || input.data.length === 0 || input.mimeType.length === 0) {
        return null;
    }
    const query = new URLSearchParams({
        mime: input.mimeType,
        animated: input.animated ? '1' : '0',
        video: input.video ? '1' : '0',
        repaint: input.needsRepainting ? '1' : '0',
    });
    const request = createTimedController(EMOJI_TIMEOUT_MS, signal);
    try {
        const response = await fetch(`${TGS_CONVERTER_URL}/emoji-preview?${query.toString()}`, {
            method: 'POST',
            headers: { 'Content-Type': input.mimeType },
            body: input.data,
            signal: request.signal,
        });
        return await readPngResponse(response, 'emoji preview', MAX_EMOJI_PREVIEW_BYTES);
    } catch (error) {
        console.error('[tgs-client] emoji preview request error:', error instanceof Error ? error.message : error);
        return null;
    } finally {
        request.dispose();
    }
};

export const createCustomEmojiAtlas = async (
    items: readonly CustomEmojiAtlasItem[],
    signal?: AbortSignal
): Promise<CustomEmojiImage | null> => {
    if (!TGS_CONVERTER_URL || items.length === 0 || items.length > MAX_EMOJI_ATLAS_ITEMS) {
        return null;
    }
    if (items.some((item) => item.image.length === 0 || !/^E(?:[1-9]|1[0-6])$/.test(item.label))) {
        return null;
    }
    const request = createTimedController(EMOJI_TIMEOUT_MS, signal);
    try {
        const response = await fetch(`${TGS_CONVERTER_URL}/emoji-atlas`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: items.map((item) => ({
                    label: item.label,
                    imageBase64: item.image.toString('base64'),
                })),
            }),
            signal: request.signal,
        });
        return await readPngResponse(response, 'emoji atlas', MAX_EMOJI_ATLAS_BYTES);
    } catch (error) {
        console.error('[tgs-client] emoji atlas request error:', error instanceof Error ? error.message : error);
        return null;
    } finally {
        request.dispose();
    }
};
