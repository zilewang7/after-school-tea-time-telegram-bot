/**
 * Read an image's pixel dimensions out of its header.
 *
 * Only the header is needed, so a 20 MiB photo never gets decoded — just far
 * enough in to find the size box. Used to let `/vid` follow the shape of the
 * picture someone attached instead of defaulting everything to 16:9.
 */

export interface ImageSize {
    width: number;
    height: number;
}

/** Enough for a PNG/GIF/WebP header and for a JPEG's EXIF block plus its SOF */
const HEADER_BYTES = 256 * 1024;

const png = (data: Buffer): ImageSize | null => {
    if (data.length < 24) return null;
    if (data.readUInt32BE(12) !== 0x49484452) return null; // 'IHDR'
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
};

const gif = (data: Buffer): ImageSize | null =>
    data.length < 10 ? null : { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };

/**
 * JPEG carries its size in a start-of-frame marker that sits after a variable
 * run of other segments, so the segment chain has to be walked.
 */
const jpeg = (data: Buffer): ImageSize | null => {
    let offset = 2;
    while (offset + 9 < data.length) {
        if (data[offset] !== 0xff) {
            offset += 1;
            continue;
        }
        const marker = data[offset + 1] ?? 0;
        // SOF0-SOF15, minus the DHT/JPG/DAC markers interleaved in that range
        const isFrameStart =
            marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        // The frame header stores height before width, unlike everything else
        if (isFrameStart) {
            return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
        }
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
            offset += 2;
            continue;
        }
        offset += 2 + data.readUInt16BE(offset + 2);
    }
    return null;
};

/** WebP has three container flavours and each stores the size differently */
const webp = (data: Buffer): ImageSize | null => {
    const format = data.toString('ascii', 12, 16);
    if (format === 'VP8X' && data.length >= 30) {
        return {
            width: 1 + (data.readUIntLE(24, 3) & 0xffffff),
            height: 1 + (data.readUIntLE(27, 3) & 0xffffff),
        };
    }
    if (format === 'VP8L' && data.length >= 25) {
        const bits = data.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (format === 'VP8 ' && data.length >= 30) {
        return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    }
    return null;
};

const readBufferSize = (data: Buffer): ImageSize | null => {
    if (data.length < 16) return null;

    const size =
        data.toString('ascii', 1, 4) === 'PNG'
            ? png(data)
            : data.toString('ascii', 0, 3) === 'GIF'
                ? gif(data)
                : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
                    ? webp(data)
                    : data[0] === 0xff && data[1] === 0xd8
                        ? jpeg(data)
                        : null;

    // A zero dimension is a malformed header, not a usable answer
    return size && size.width > 0 && size.height > 0 ? size : null;
};

/** `null` for an unsupported or truncated format — callers fall back to a default */
export const readImageSize = (base64: string): ImageSize | null => {
    // Base64 decodes in 4-character groups; a ragged slice would corrupt the tail
    const prefix = base64.slice(0, Math.ceil((HEADER_BYTES * 4) / 3 / 4) * 4);
    try {
        return readBufferSize(Buffer.from(prefix, 'base64'));
    } catch {
        return null;
    }
};
