/**
 * Image formats told apart by their magic bytes.
 *
 * A stored MIME type is not good enough to label a reference image or name an
 * upload: legacy rows carry none (and are read back as PNG), and a reply
 * version keeps its image as bare base64. The bytes always say what they are.
 *
 * Two views of the same bytes:
 * - `sniffImageMime` is the strict set the image model takes as references and
 *   that every platform can display (PNG/JPEG/WebP).
 * - `sniffMediaMime` adds GIF, which can be sent to the chat as an animation
 *   but is read by a model as a single frame (see the 2026-10-23 design doc).
 */

/** The formats the image model takes as reference images */
export type SniffedImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

/** Animated media that can be delivered to the chat but not used as a reference */
export type SniffedAnimatedMime = 'image/gif';

/** Everything the reply tools can deliver or download */
export type SniffedMediaMime = SniffedImageMime | SniffedAnimatedMime;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const isPng = (data: Buffer): boolean =>
    data.length >= PNG_SIGNATURE.length && data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);

const isJpeg = (data: Buffer): boolean =>
    data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;

/** RIFF container whose form type is WEBP */
const isWebp = (data: Buffer): boolean =>
    data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';

const isGif = (data: Buffer): boolean => {
    if (data.length < 6) return false;
    const header = data.toString('ascii', 0, 6);
    return header === 'GIF87a' || header === 'GIF89a';
};

const SIGNATURES: ReadonlyArray<{ readonly mime: SniffedImageMime; readonly matches: (data: Buffer) => boolean }> = [
    { mime: 'image/png', matches: isPng },
    { mime: 'image/jpeg', matches: isJpeg },
    { mime: 'image/webp', matches: isWebp },
];

/** null for anything else: HEIC, truncated bytes or no image at all */
export const sniffImageMime = (data: Buffer): SniffedImageMime | null =>
    SIGNATURES.find((signature) => signature.matches(data))?.mime ?? null;

/** Like `sniffImageMime`, but a GIF counts as media the chat can receive */
export const sniffMediaMime = (data: Buffer): SniffedMediaMime | null =>
    sniffImageMime(data) ?? (isGif(data) ? 'image/gif' : null);

const FILE_EXTENSIONS: Readonly<Record<SniffedMediaMime, string>> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
};

/**
 * Upload name matching the bytes; an unknown format keeps the old image.png.
 * The extension decides how Telegram routes an upload, so a GIF must not be
 * named .png (sendAnimation would refuse it).
 */
export const imageFileName = (data: Buffer): string =>
    `image.${FILE_EXTENSIONS[sniffMediaMime(data) ?? 'image/png']}`;
