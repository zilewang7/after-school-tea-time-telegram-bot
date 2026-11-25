/**
 * Client for the tgs-converter microservice.
 * Converts Telegram .tgs animated stickers to .webm so multimodal models can
 * process them. Returns null on any failure (caller falls back to thumbnail).
 */

const TGS_CONVERTER_URL = process.env.TGS_CONVERTER_URL;
const CONVERT_TIMEOUT_MS = 30000;
const NORMALIZE_TIMEOUT_MS = 30000;
const EMOJI_TIMEOUT_MS = 30000;
const FRAME_TIMEOUT_MS = 15000;
const STILL_TIMEOUT_MS = 15000;
const MAX_FRAME_BYTES = 6 * 1024 * 1024;
const MAX_EMOJI_ATLAS_ITEMS = 8;
const MAX_EMOJI_PREVIEW_BYTES = 1024 * 1024;
const MAX_EMOJI_ATLAS_BYTES = 512 * 1024;

const createTimedController = (
    timeoutMs: number,
    parentSignal?: AbortSignal
): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } => {
    const controller = new AbortController();
    let didTimeout = false;
    const abortFromParent = (): void => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    const timer = setTimeout(() => {
        didTimeout = true;
        controller.abort(new Error('request timed out'));
    }, timeoutMs);
    return {
        signal: controller.signal,
        dispose: () => {
            clearTimeout(timer);
            parentSignal?.removeEventListener('abort', abortFromParent);
        },
        timedOut: () => didTimeout,
    };
};

export interface ConvertedTgs {
    data: Buffer;
    mime: string;
}

export interface ConvertedTgsStill {
    data: Buffer;
    mime: 'image/png';
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
 * Render one frame of a .tgs as PNG via the converter service.
 *
 * The fallback for documents above the full-clip node ceiling: a still frame
 * still shows the artwork, where "you cannot see it" shows nothing.
 * Returns null if the service is unconfigured, unreachable, or fails.
 */
export const renderTgsStill = async (tgs: Buffer, frame?: number): Promise<ConvertedTgsStill | null> => {
    if (!TGS_CONVERTER_URL) {
        console.warn('[tgs-client] TGS_CONVERTER_URL not set, skipping still render');
        return null;
    }

    const request = createTimedController(STILL_TIMEOUT_MS);
    try {
        // Direct call on the docker network — no Telegram proxy agent here.
        const res = await fetch(`${TGS_CONVERTER_URL}/still?frame=${frame ?? 'auto'}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: tgs,
            signal: request.signal,
        });

        if (!res.ok) {
            console.error(`[tgs-client] still failed: HTTP ${res.status}`);
            return null;
        }

        const arrayBuffer = await res.arrayBuffer();
        if (arrayBuffer.byteLength === 0) {
            console.error('[tgs-client] still returned an empty body');
            return null;
        }
        return { data: Buffer.from(arrayBuffer), mime: 'image/png' };
    } catch (error) {
        console.error('[tgs-client] still request error:', error instanceof Error ? error.message : error);
        return null;
    } finally {
        request.dispose();
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

/**
 * Re-encode a video into MP4/H.264 through the converter's normalize endpoint
 * with `format=mp4`, which skips the pass-through shortcut. Needed for models
 * that only ingest MP4-family containers (MiMo rejects webm outright, e.g. every
 * animated sticker). Returns null on any failure — the caller drops the media
 * part and keeps the text hint.
 */
export const transcodeVideoToMp4 = async (
    video: Buffer,
    mimeType: string
): Promise<NormalizedVideo | null> => {
    if (!TGS_CONVERTER_URL) {
        console.warn('[tgs-client] TGS_CONVERTER_URL not set, skipping video transcode');
        return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NORMALIZE_TIMEOUT_MS);

    try {
        const query = `mime=${encodeURIComponent(mimeType)}&format=mp4`;
        const res = await fetch(`${TGS_CONVERTER_URL}/normalize-video?${query}`, {
            method: 'POST',
            headers: { 'Content-Type': mimeType },
            body: video,
            signal: controller.signal,
        });

        if (!res.ok) {
            console.error(`[tgs-client] transcode failed: HTTP ${res.status}`);
            return null;
        }

        const arrayBuffer = await res.arrayBuffer();
        const responseMime = res.headers.get('content-type')?.split(';')[0] ?? 'video/mp4';
        return {
            data: Buffer.from(arrayBuffer),
            mimeType: responseMime,
            normalized: res.headers.get('x-normalized') === '1',
        };
    } catch (error) {
        console.error('[tgs-client] transcode request error:', error instanceof Error ? error.message : error);
        return null;
    } finally {
        clearTimeout(timer);
    }
};

export interface ExtractedFrame {
    data: Buffer;
    mimeType: 'image/png' | 'image/jpeg';
}

/**
 * First frame of an animation or video sticker, as a still image.
 * JPEG for mp4 (small, photographic), PNG for webm (stickers may carry alpha).
 * Returns null on any failure — the caller falls back to "no picture".
 */
export const extractVideoFrame = async (
    video: Buffer,
    mimeType: string,
    signal?: AbortSignal
): Promise<ExtractedFrame | null> => {
    if (!TGS_CONVERTER_URL || video.length === 0 || !mimeType.startsWith('video/')) return null;

    const format = mimeType === 'video/webm' ? 'png' : 'jpeg';
    const request = createTimedController(FRAME_TIMEOUT_MS, signal);
    try {
        const query = `mime=${encodeURIComponent(mimeType)}&format=${format}`;
        const res = await fetch(`${TGS_CONVERTER_URL}/frame?${query}`, {
            method: 'POST',
            headers: { 'Content-Type': mimeType },
            body: video,
            signal: request.signal,
        });
        if (!res.ok) {
            console.error(`[tgs-client] frame failed: HTTP ${res.status}`);
            return null;
        }

        const responseMime = res.headers.get('content-type')?.split(';')[0];
        if (responseMime !== 'image/png' && responseMime !== 'image/jpeg') {
            console.error(`[tgs-client] frame returned unexpected content type: ${responseMime ?? 'missing'}`);
            return null;
        }

        const contentLength = Number(res.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > MAX_FRAME_BYTES) {
            console.error(`[tgs-client] frame response exceeds ${MAX_FRAME_BYTES} bytes`);
            return null;
        }

        const arrayBuffer = await res.arrayBuffer();
        if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength > MAX_FRAME_BYTES) {
            console.error('[tgs-client] frame returned an empty or oversized body');
            return null;
        }
        return { data: Buffer.from(arrayBuffer), mimeType: responseMime };
    } catch (error) {
        console.error('[tgs-client] frame request error:', error instanceof Error ? error.message : error);
        return null;
    } finally {
        request.dispose();
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

// ---------------------------------------------------------------------------
// Crop and multi-frame extraction (design 2026-1124-2230)
//
// Both are local media operations on bytes the reply already holds (or on a
// short-lived signed URL for a >20MB video). They answer structured outcomes
// instead of null: the tool has to tell the model what to fix (the box unit,
// the clip duration) without guessing from an HTTP status.
// ---------------------------------------------------------------------------

const CROP_TIMEOUT_MS = 15000;
/** The sidecar caps the image at 2MB; a little slack covers headers */
const CROP_MAX_RESPONSE_BYTES = 2 * 1024 * 1024 + 64 * 1024;
const FRAMES_BODY_TIMEOUT_MS = 35000;
const FRAMES_REMOTE_TIMEOUT_MS = 90000;
/** Base64 inflates by 4/3; the sidecar caps raw frames at 8MB */
const FRAMES_MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const FRAMES_MAX_COUNT = 6;

export const isTgsConverterConfigured = (): boolean => Boolean(TGS_CONVERTER_URL);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const numberField = (record: Record<string, unknown>, key: string): number | null => {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const textField = (record: Record<string, unknown>, key: string): string | null => {
    const value = record[key];
    return typeof value === 'string' ? value : null;
};

const parseRecord = (text: string): Record<string, unknown> | null => {
    try {
        const parsed: unknown = JSON.parse(text);
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

const isStillMime = (value: string | null): value is 'image/jpeg' | 'image/png' =>
    value === 'image/jpeg' || value === 'image/png';

const isStillMagic = (data: Buffer, mimeType: 'image/jpeg' | 'image/png'): boolean =>
    mimeType === 'image/png'
        ? data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
        : data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;

export interface CropImageInput {
    readonly data: Buffer;
    readonly x1: number;
    readonly y1: number;
    readonly x2: number;
    readonly y2: number;
    readonly unit: 'norm1000' | 'px';
    readonly maxEdge?: number;
    readonly scale?: number;
}

export interface CropImageSuccess {
    readonly ok: true;
    readonly data: Buffer;
    readonly mimeType: 'image/jpeg' | 'image/png';
    readonly sourceWidth: number;
    readonly sourceHeight: number;
    readonly box: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number };
    readonly outputWidth: number;
    readonly outputHeight: number;
    readonly flags: readonly string[];
}

/** Parse a non-negative integer header; null/empty must fail rather than coerce to 0 */
const parseNonNegativeHeaderInt = (headers: Headers, name: string): number | null => {
    const raw = headers.get(name);
    if (raw === null) return null;
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const value = Number(trimmed);
    return Number.isSafeInteger(value) ? value : null;
};

const isTimeoutError = (error: unknown): boolean =>
    error instanceof Error && (error.name === 'TimeoutError' || /\btimed out\b/i.test(error.message));

export type CropImageOutcome =
    | CropImageSuccess
    | {
          readonly ok: false;
          readonly reason: 'invalid-box' | 'invalid-args' | 'too-large' | 'unsupported' | 'timeout' | 'failed';
          readonly message?: string;
          readonly sourceWidth?: number;
          readonly sourceHeight?: number;
      };

/**
 * Crop one region and let the sidecar magnify it. `reason: 'invalid-box'`
 * comes with the source dimensions so the tool can tell the model what it got
 * wrong (a norm1000 box sent as pixels, a box that is too small).
 */
export const cropImage = async (
    input: CropImageInput,
    signal?: AbortSignal
): Promise<CropImageOutcome> => {
    if (!TGS_CONVERTER_URL) return { ok: false, reason: 'failed', message: 'TGS_CONVERTER_URL is not configured' };
    if (input.data.length === 0) return { ok: false, reason: 'failed', message: 'empty input image' };
    const query = new URLSearchParams({
        x1: String(input.x1),
        y1: String(input.y1),
        x2: String(input.x2),
        y2: String(input.y2),
        unit: input.unit,
        ...(input.maxEdge === undefined ? {} : { max_edge: String(input.maxEdge) }),
        ...(input.scale === undefined ? {} : { scale: String(input.scale) }),
    });
    const request = createTimedController(CROP_TIMEOUT_MS, signal);
    try {
        const res = await fetch(`${TGS_CONVERTER_URL}/crop?${query.toString()}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: input.data,
            signal: request.signal,
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            const trimmedBody = body.trim();
            if (res.status === 400) {
                const detail = parseRecord(body);
                const message = detail === null ? trimmedBody || undefined : textField(detail, 'error') ?? undefined;
                return {
                    ok: false,
                    reason: 'invalid-args',
                    ...(message === undefined ? {} : { message }),
                };
            }
            if (res.status === 408 || res.status === 504) {
                return {
                    ok: false,
                    reason: 'timeout',
                    message: trimmedBody || `HTTP ${res.status}`,
                };
            }
            if (res.status === 413) return { ok: false, reason: 'too-large' };
            if (res.status === 415) return { ok: false, reason: 'unsupported' };
            if (res.status === 422) {
                const detail = parseRecord(body);
                const message = detail === null ? undefined : textField(detail, 'error') ?? undefined;
                const sourceWidth = detail === null ? null : numberField(detail, 'width');
                const sourceHeight = detail === null ? null : numberField(detail, 'height');
                return {
                    ok: false,
                    reason: 'invalid-box',
                    ...(message === undefined ? {} : { message }),
                    ...(sourceWidth === null ? {} : { sourceWidth }),
                    ...(sourceHeight === null ? {} : { sourceHeight }),
                };
            }
            if ((res.status === 500 || res.status === 503) && /\btimed out\b/i.test(trimmedBody)) {
                console.error(`[tgs-client] crop timed out: HTTP ${res.status} ${trimmedBody}`);
                return { ok: false, reason: 'timeout', message: trimmedBody };
            }
            console.error(`[tgs-client] crop failed: HTTP ${res.status}`);
            return { ok: false, reason: 'failed', message: trimmedBody || `HTTP ${res.status}` };
        }
        const mimeType = res.headers.get('content-type')?.split(';')[0] ?? null;
        if (!isStillMime(mimeType)) {
            console.error('[tgs-client] crop returned an unexpected content type');
            return { ok: false, reason: 'failed', message: 'unexpected content type' };
        }
        const sourceWidth = parseNonNegativeHeaderInt(res.headers, 'x-source-width');
        const sourceHeight = parseNonNegativeHeaderInt(res.headers, 'x-source-height');
        const boxX1 = parseNonNegativeHeaderInt(res.headers, 'x-crop-x1');
        const boxY1 = parseNonNegativeHeaderInt(res.headers, 'x-crop-y1');
        const boxX2 = parseNonNegativeHeaderInt(res.headers, 'x-crop-x2');
        const boxY2 = parseNonNegativeHeaderInt(res.headers, 'x-crop-y2');
        const outputWidth = parseNonNegativeHeaderInt(res.headers, 'x-output-width');
        const outputHeight = parseNonNegativeHeaderInt(res.headers, 'x-output-height');
        // x1/y1 are 0-based coordinates and legitimately 0 on left/top edge crops
        if (
            sourceWidth === null || sourceWidth <= 0
            || sourceHeight === null || sourceHeight <= 0
            || boxX1 === null
            || boxY1 === null
            || boxX2 === null || boxX2 <= boxX1 || boxX2 > sourceWidth
            || boxY2 === null || boxY2 <= boxY1 || boxY2 > sourceHeight
            || outputWidth === null || outputWidth <= 0
            || outputHeight === null || outputHeight <= 0
        ) {
            console.error('[tgs-client] crop returned unusable metadata');
            return { ok: false, reason: 'failed', message: 'unusable metadata' };
        }
        const box = { x1: boxX1, y1: boxY1, x2: boxX2, y2: boxY2 };
        const arrayBuffer = await res.arrayBuffer();
        if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength > CROP_MAX_RESPONSE_BYTES) {
            console.error('[tgs-client] crop returned an empty or oversized body');
            return { ok: false, reason: 'failed', message: 'empty or oversized response' };
        }
        const data = Buffer.from(arrayBuffer);
        if (!isStillMagic(data, mimeType)) {
            console.error('[tgs-client] crop returned bytes that are not the announced format');
            return { ok: false, reason: 'failed', message: 'invalid image magic bytes' };
        }
        return {
            ok: true,
            data,
            mimeType,
            sourceWidth,
            sourceHeight,
            box,
            outputWidth,
            outputHeight,
            flags: (res.headers.get('x-crop-flags') ?? '').split(',').filter((flag) => flag !== ''),
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[tgs-client] crop request error:', message);
        return request.timedOut() || isTimeoutError(error)
            ? { ok: false, reason: 'timeout', message }
            : { ok: false, reason: 'failed', message };
    } finally {
        request.dispose();
    }
};

export type FrameSize = 512 | 768 | 960 | 1280;

export interface ExtractVideoFramesInput {
    /**
     * Inline bytes (≤20MB, the media cache path) or a signed https URL for a
     * >20MB video that only exists in GCS. The bot never downloads the latter.
     */
    readonly source:
        | { readonly kind: 'bytes'; readonly data: Buffer; readonly mimeType: string }
        | { readonly kind: 'url'; readonly url: string; readonly mimeType: string; readonly sourceBytes?: number };
    readonly mode: 'times' | 'uniform' | 'first' | 'last';
    readonly times?: readonly number[];
    readonly count?: number;
    readonly start?: number;
    readonly end?: number;
    readonly size?: FrameSize;
}

export interface ExtractedVideoFrame {
    readonly requestedT: number;
    readonly actualT: number;
    readonly mimeType: 'image/jpeg' | 'image/png';
    readonly width: number | null;
    readonly height: number | null;
    readonly data: Buffer;
}

export interface ExtractVideoFramesSuccess {
    readonly ok: true;
    readonly duration: number;
    readonly width: number;
    readonly height: number;
    readonly fps: number | null;
    readonly rotation: number;
    readonly frames: readonly ExtractedVideoFrame[];
    readonly notes: readonly string[];
}

export type ExtractVideoFramesOutcome =
    | ExtractVideoFramesSuccess
    | {
          readonly ok: false;
          readonly reason: 'invalid-time' | 'too-large' | 'unsupported' | 'failed';
          readonly message?: string;
          readonly duration?: number;
      };

/**
 * Extract stills of a clip through the converter. The remote form hands the
 * sidecar a signed URL, so a >20MB GCS video is read by ffmpeg in place and
 * only the bytes it seeks over ever leave storage.
 */
export const extractVideoFrames = async (
    input: ExtractVideoFramesInput,
    signal?: AbortSignal
): Promise<ExtractVideoFramesOutcome> => {
    if (!TGS_CONVERTER_URL) return { ok: false, reason: 'failed' };
    const query = new URLSearchParams({
        mime: input.source.mimeType,
        mode: input.mode,
        size: String(input.size ?? 960),
        ...(input.times === undefined ? {} : { times: input.times.map((time) => String(time)).join(',') }),
        ...(input.count === undefined ? {} : { count: String(input.count) }),
        ...(input.start === undefined ? {} : { start: String(input.start) }),
        ...(input.end === undefined ? {} : { end: String(input.end) }),
        ...(input.source.kind === 'url' ? { url: input.source.url } : {}),
        ...(input.source.kind === 'url' && input.source.sourceBytes !== undefined
            ? { sourceBytes: String(input.source.sourceBytes) }
            : {}),
    });
    const timeoutMs = input.source.kind === 'url' ? FRAMES_REMOTE_TIMEOUT_MS : FRAMES_BODY_TIMEOUT_MS;
    const request = createTimedController(timeoutMs, signal);
    try {
        const res = await fetch(`${TGS_CONVERTER_URL}/frames?${query.toString()}`, {
            method: 'POST',
            ...(input.source.kind === 'bytes'
                ? {
                      headers: { 'Content-Type': 'application/octet-stream' },
                      body: input.source.data,
                  }
                : {}),
            signal: request.signal,
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            if (res.status === 413) return { ok: false, reason: 'too-large' };
            if (res.status === 415) return { ok: false, reason: 'unsupported' };
            if (res.status === 422) {
                const detail = parseRecord(body);
                const message = detail === null ? undefined : textField(detail, 'error') ?? undefined;
                const duration = detail === null ? null : numberField(detail, 'duration');
                return {
                    ok: false,
                    reason: 'invalid-time',
                    ...(message === undefined ? {} : { message }),
                    ...(duration === null ? {} : { duration }),
                };
            }
            console.error(`[tgs-client] frames failed: HTTP ${res.status}`);
            return { ok: false, reason: 'failed' };
        }
        const arrayBuffer = await res.arrayBuffer();
        if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength > FRAMES_MAX_RESPONSE_BYTES) {
            console.error('[tgs-client] frames returned an empty or oversized body');
            return { ok: false, reason: 'failed' };
        }
        const parsed = parseRecord(Buffer.from(arrayBuffer).toString('utf8'));
        if (parsed === null) {
            console.error('[tgs-client] frames returned unreadable JSON');
            return { ok: false, reason: 'failed' };
        }
        const duration = numberField(parsed, 'duration');
        const width = numberField(parsed, 'width');
        const height = numberField(parsed, 'height');
        const rawFrames = parsed.frames;
        if (
            duration === null
            || width === null
            || height === null
            || !Array.isArray(rawFrames)
            || rawFrames.length === 0
            || rawFrames.length > FRAMES_MAX_COUNT
        ) {
            console.error('[tgs-client] frames returned unusable metadata');
            return { ok: false, reason: 'failed' };
        }
        const frames: ExtractedVideoFrame[] = [];
        let totalBytes = 0;
        for (const rawFrame of rawFrames) {
            if (!isRecord(rawFrame)) return { ok: false, reason: 'failed' };
            const requestedT = numberField(rawFrame, 'requestedT');
            const actualT = numberField(rawFrame, 'actualT');
            const mimeType = textField(rawFrame, 'mime');
            const base64 = textField(rawFrame, 'data');
            if (requestedT === null || actualT === null || !isStillMime(mimeType) || base64 === null) {
                console.error('[tgs-client] frames returned a malformed frame');
                return { ok: false, reason: 'failed' };
            }
            const data = Buffer.from(base64, 'base64');
            if (data.length === 0 || !isStillMagic(data, mimeType)) {
                console.error('[tgs-client] frames returned bytes that are not the announced format');
                return { ok: false, reason: 'failed' };
            }
            totalBytes += data.length;
            frames.push({
                requestedT,
                actualT,
                mimeType,
                width: numberField(rawFrame, 'width'),
                height: numberField(rawFrame, 'height'),
                data,
            });
        }
        if (totalBytes > FRAMES_MAX_RESPONSE_BYTES) {
            console.error('[tgs-client] frames exceed the response size limit');
            return { ok: false, reason: 'failed' };
        }
        const rotation = numberField(parsed, 'rotation');
        const notes = Array.isArray(parsed.notes)
            ? parsed.notes.filter((note): note is string => typeof note === 'string')
            : [];
        return {
            ok: true,
            duration,
            width,
            height,
            fps: numberField(parsed, 'fps'),
            rotation: rotation ?? 0,
            frames,
            notes,
        };
    } catch (error) {
        console.error('[tgs-client] frames request error:', error instanceof Error ? error.message : error);
        return { ok: false, reason: 'failed' };
    } finally {
        request.dispose();
    }
};
