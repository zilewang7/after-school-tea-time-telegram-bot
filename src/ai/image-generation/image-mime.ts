/**
 * Image formats told apart by their magic bytes.
 *
 * A stored MIME type is not good enough to label a reference image or name an
 * upload: legacy rows carry none (and are read back as PNG), and a reply
 * version keeps its image as bare base64. The bytes always say what they are.
 */

/** The formats the image model takes as reference images */
export type SniffedImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const isPng = (data: Buffer): boolean =>
    data.length >= PNG_SIGNATURE.length && data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);

const isJpeg = (data: Buffer): boolean =>
    data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;

/** RIFF container whose form type is WEBP */
const isWebp = (data: Buffer): boolean =>
    data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';

const SIGNATURES: ReadonlyArray<{ readonly mime: SniffedImageMime; readonly matches: (data: Buffer) => boolean }> = [
    { mime: 'image/png', matches: isPng },
    { mime: 'image/jpeg', matches: isJpeg },
    { mime: 'image/webp', matches: isWebp },
];

/** null for anything else: GIF, HEIC, truncated bytes or no image at all */
export const sniffImageMime = (data: Buffer): SniffedImageMime | null =>
    SIGNATURES.find((signature) => signature.matches(data))?.mime ?? null;

const FILE_EXTENSIONS: Readonly<Record<SniffedImageMime, string>> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
};

/** Upload name matching the bytes; an unknown format keeps the old image.png */
export const imageFileName = (data: Buffer): string =>
    `image.${FILE_EXTENSIONS[sniffImageMime(data) ?? 'image/png']}`;
