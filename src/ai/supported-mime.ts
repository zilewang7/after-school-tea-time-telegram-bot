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
