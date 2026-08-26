/**
 * Client for the tgs-converter microservice.
 * Converts Telegram .tgs animated stickers to .webm so multimodal models can
 * process them. Returns null on any failure (caller falls back to thumbnail).
 */

const TGS_CONVERTER_URL = process.env.TGS_CONVERTER_URL;
const CONVERT_TIMEOUT_MS = 30000;
const NORMALIZE_TIMEOUT_MS = 30000;

export interface ConvertedTgs {
    data: Buffer;
    mime: string;
}

export interface NormalizedVideo {
    data: Buffer;
    mimeType: string;
    normalized: boolean;
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
