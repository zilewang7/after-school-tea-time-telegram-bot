/**
 * Single source of truth for which media MIME types Gemini can natively ingest
 * as inlineData / fileData. Feeding anything else (archives, office docs, unknown
 * binaries) makes Vertex reject the WHOLE request with a 400 INVALID_ARGUMENT,
 * which breaks every reply in that context chain. Such parts are therefore
 * dropped before sending and skipped at download time; the message keeps its
 * text hint so the model still knows a file was shared.
 *
 * Lists unioned from the Vertex AI + Gemini API docs (image/video/audio/pdf).
 * text/* is always feedable (Gemini extracts it as plain text), so it is matched
 * by prefix rather than enumerated.
 */

// Exact binary types Gemini accepts.
const SUPPORTED_EXACT: ReadonlySet<string> = new Set([
    // images
    'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif',
    // video
    'video/mp4', 'video/mpeg', 'video/mov', 'video/quicktime', 'video/avi',
    'video/x-msvideo', 'video/x-flv', 'video/mpg', 'video/mpegps',
    'video/webm', 'video/wmv', 'video/x-ms-wmv', 'video/3gpp',
    // audio
    'audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/mpga', 'audio/aiff',
    'audio/aac', 'audio/ogg', 'audio/opus', 'audio/flac', 'audio/m4a',
    'audio/mp4', 'audio/pcm', 'audio/webm',
    // documents
    'application/pdf',
    // text-ish application types Gemini extracts as plain text
    'application/json', 'application/xml', 'application/rtf',
    'application/x-javascript', 'application/x-python', 'application/x-typescript',
]);

// Legacy aliases mapped to a canonical type Gemini definitely accepts, so a
// stored variant (e.g. Telegram's audio/x-wav) is still fed instead of dropped.
const ALIAS: ReadonlyMap<string, string> = new Map([
    ['audio/x-wav', 'audio/wav'],
    ['audio/wave', 'audio/wav'],
    ['audio/x-aiff', 'audio/aiff'],
    ['audio/x-flac', 'audio/flac'],
    ['audio/x-m4a', 'audio/m4a'],
    ['image/jpg', 'image/jpeg'],
]);

/** Canonicalize a known alias; pass everything else through unchanged. */
export const normalizeMimeType = (mime: string): string => ALIAS.get(mime) ?? mime;

export type VisionImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** Image types shared by OpenAI Responses, Grok Responses, and Anthropic. */
export const toVisionImageMimeType = (
    mime: string | null | undefined
): VisionImageMimeType | null => {
    const normalized = normalizeMimeType(mime ?? 'image/png');
    if (
        normalized === 'image/png'
        || normalized === 'image/jpeg'
        || normalized === 'image/gif'
        || normalized === 'image/webp'
    ) {
        return normalized;
    }
    return null;
};

/**
 * True if Gemini can ingest this MIME type as binary media.
 * Aliases are normalized first; any text/* type is always accepted.
 */
export const isGeminiSupportedMimeType = (mime: string | null | undefined): boolean => {
    if (!mime) return false;
    const normalized = normalizeMimeType(mime);
    if (normalized.startsWith('text/')) return true;
    return SUPPORTED_EXACT.has(normalized);
};

/**
 * MiMo (mimo-v2.6-flash / pro) ingest policy — a stricter, differently shaped
 * set than Gemini's, so it gets its own lists:
 * - image: jpeg/png/gif/webp/bmp;
 * - audio: mp3/wav/flac/m4a/ogg (Telegram voice notes are audio/ogg);
 * - video: mp4/mov/avi/wmv only — webm is rejected by the API;
 * - documents: no channel at all (an OpenAI-style `file` part is a hard 400).
 * Anything outside these lists must be dropped (or re-encoded, see below)
 * before the request: one bad part 400s the whole conversation context.
 */
const MIMO_IMAGE_MIMES: ReadonlySet<string> = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
    'image/jpg', // alias of image/jpeg
]);

const MIMO_AUDIO_MIMES: ReadonlySet<string> = new Set([
    'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/flac',
    'audio/x-flac', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/ogg',
]);

const MIMO_VIDEO_MIMES: ReadonlySet<string> = new Set([
    'video/mp4', 'video/mov', 'video/quicktime', 'video/avi',
    'video/x-msvideo', 'video/wmv', 'video/x-ms-wmv',
]);

/**
 * Video containers MiMo does not take but the tgs-converter can re-encode into
 * MP4 (mirrors its NORMALIZE_VIDEO_MIMES). This is what makes animated stickers
 * (.webm) usable at all.
 */
const MIMO_TRANSCODABLE_VIDEO_MIMES: ReadonlySet<string> = new Set([
    'video/webm', 'video/mpeg', 'video/mpg', 'video/mpegps', 'video/x-flv', 'video/3gpp',
]);

export const isMimoSupportedImageMime = (mime: string): boolean =>
    MIMO_IMAGE_MIMES.has(normalizeMimeType(mime));

export const isMimoSupportedMediaMime = (mime: string): boolean =>
    MIMO_AUDIO_MIMES.has(mime) || MIMO_VIDEO_MIMES.has(mime);

/** Any binary type MiMo ingests as-is, images included. */
export const isMimoIngestibleMime = (mime: string): boolean =>
    isMimoSupportedImageMime(mime) || isMimoSupportedMediaMime(mime);

export const isMimoTranscodableVideoMime = (mime: string): boolean =>
    MIMO_TRANSCODABLE_VIDEO_MIMES.has(mime);
