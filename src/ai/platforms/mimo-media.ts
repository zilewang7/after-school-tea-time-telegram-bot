/**
 * MiMo media preparation: what happens to an attachment between the stored
 * context and a mimo-v2.6 request.
 *
 * The ingest policy lives in `../supported-mime.ts` (images / audio / video
 * lists and the transcodable set). Two kinds of attachment are not simply
 * dropped, they are prepared:
 * - webm-family video (every animated sticker, .tgs renders included) is
 *   re-encoded to MP4 by the converter service — the API rejects webm outright;
 * - media too large to inline (>20MB lives in GCS as a gs:// reference) gets a
 *   short-lived signed URL, since MiMo fetches remote URLs itself.
 *
 * Anything else outside the policy is dropped here, keeping the message's text
 * hint in place: one bad part 400s the entire request, which would break every
 * reply in that context chain.
 */
import { createSignedReadUrl } from '../../services/gcs-service.js';
import { transcodeVideoToMp4 } from '../../services/tgs-client.js';
import {
    isMimoIngestibleMime,
    isMimoSupportedImageMime,
    isMimoSupportedMediaMime,
    isMimoTranscodableVideoMime,
} from '../supported-mime.js';
import type { UnifiedContentPart, UnifiedMessage } from '../types.js';

/** MiMo takes base64 payloads up to 50MB, i.e. ~37MB of raw bytes. */
const MAX_INLINE_BYTES = 37 * 1024 * 1024;

/** Per-kind caps for the remote-URL path (platform docs). */
const MAX_REMOTE_BYTES_BY_PREFIX: ReadonlyArray<{ prefix: string; maxBytes: number }> = [
    { prefix: 'video/', maxBytes: 300 * 1024 * 1024 },
    { prefix: 'audio/', maxBytes: 100 * 1024 * 1024 },
    { prefix: 'image/', maxBytes: 50 * 1024 * 1024 },
];

/** Default lifetime of a signed media URL: long enough for a slow first token. */
const DEFAULT_SIGNED_URL_TTL_SECONDS = 60 * 60;

/** Whether a part survives as-is, needs a signed URL, or can be transcoded. */
type PartPlan = 'keep' | 'remote' | 'transcode' | 'drop';

const planPart = (part: UnifiedContentPart): PartPlan => {
    const mime = part.mimeType ?? (part.type === 'image' ? 'image/png' : '');

    // No bytes at hand: only a signed URL can carry an oversized GCS object.
    if (part.fileUri) {
        return isMimoIngestibleMime(mime) ? 'remote' : 'drop';
    }

    if (part.type === 'image') {
        return isMimoSupportedImageMime(mime) ? 'keep' : 'drop';
    }
    if (isMimoSupportedMediaMime(mime)) {
        return 'keep';
    }
    return isMimoTranscodableVideoMime(mime) ? 'transcode' : 'drop';
};

/** True when the signed-URL route may serve this media (kind + size caps). */
const withinRemoteSizeCap = (part: UnifiedContentPart): boolean => {
    const mime = part.mimeType ?? '';
    const sizeBytes = part.sizeBytes;
    if (sizeBytes === undefined || sizeBytes === null) return true; // unknown size: let the provider decide
    const cap = MAX_REMOTE_BYTES_BY_PREFIX.find((entry) => mime.startsWith(entry.prefix));
    return cap ? sizeBytes <= cap.maxBytes : false;
};

const readSignedUrlTtlSeconds = (): number => {
    const parsed = Number(process.env.MIMO_SIGNED_URL_TTL_SECONDS);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SIGNED_URL_TTL_SECONDS;
};

/** Re-encode a webm/other-container clip into MP4 in place. */
const toMp4Part = async (
    part: UnifiedContentPart,
    logContext: string
): Promise<UnifiedContentPart | null> => {
    if (!part.mediaData) return null;

    const source = Buffer.from(part.mediaData, 'base64');
    if (source.length === 0 || source.length > MAX_INLINE_BYTES) return null;

    const transcoded = await transcodeVideoToMp4(source, part.mimeType ?? 'video/webm');
    // A converter that predates `format=mp4` answers with the input container
    // unchanged; treat that as a failure instead of forwarding a webm part the
    // request builder would only drop.
    if (!transcoded || !transcoded.mimeType.startsWith('video/mp4')) return null;

    console.log(
        `[mimo] transcoded ${part.mimeType ?? 'video'} ${source.length}B -> ${transcoded.mimeType} ${transcoded.data.length}B ${logContext}`
    );
    return {
        ...part,
        mimeType: transcoded.mimeType,
        mediaData: transcoded.data.toString('base64'),
        sizeBytes: transcoded.data.length,
    };
};

/**
 * Turn an oversized GCS-backed part into a signed URL the provider can fetch.
 * Returns null (dropped) when signing is unavailable or the file is over the
 * per-kind cap.
 */
const toRemotePart = async (part: UnifiedContentPart): Promise<UnifiedContentPart | null> => {
    if (!part.fileUri || !withinRemoteSizeCap(part)) return null;

    const remoteUrl = await createSignedReadUrl(part.fileUri, readSignedUrlTtlSeconds());
    if (!remoteUrl) return null;

    return { ...part, remoteUrl };
};

/** Prepare one part for the request: keep, transcode, sign, or drop. */
const preparePart = async (
    part: UnifiedContentPart,
    logContext: string
): Promise<UnifiedContentPart | null> => {
    if (part.type === 'text') return part;

    const plan = planPart(part);
    if (plan === 'keep') {
        const inlineBytes = part.mediaData ? Buffer.from(part.mediaData, 'base64').length : 0;
        if (inlineBytes > MAX_INLINE_BYTES) return null;
        return part;
    }

    const prepared = plan === 'remote'
        ? await toRemotePart(part)
        : plan === 'transcode'
            ? await toMp4Part(part, logContext)
            : null;

    if (!prepared) {
        console.warn(`[mimo] dropping ${part.mimeType ?? 'unknown'} ${logContext}: cannot be made ingestible`);
    }
    return prepared;
};

/**
 * Prepare the whole context for a MiMo request. Never throws: any media that
 * cannot be made ingestible is dropped, leaving the message's text hint in
 * place.
 */
export const prepareMimoMedia = async (
    messages: UnifiedMessage[]
): Promise<UnifiedMessage[]> => {
    const prepared: UnifiedMessage[] = [];

    for (const [index, message] of messages.entries()) {
        if (message.content.every((part) => part.type === 'text')) {
            prepared.push(message);
            continue;
        }

        const logContext = `message#${index}`;
        const parts: UnifiedContentPart[] = [];
        for (const part of message.content) {
            const result = await preparePart(part, logContext);
            if (result) parts.push(result);
        }
        prepared.push({ ...message, content: parts });
    }

    return prepared;
};
