/**
 * Sizes of stored payloads, without decoding them, and how they read.
 */

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = 1024 * 1024;

/** Decoded size of a base64 payload */
export const base64ByteLength = (base64: string): number => {
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
};

/** `123 KB` below a megabyte, `2.5 MB` / `31 MB` above */
export const formatByteSize = (bytes: number): string => {
    if (bytes < BYTES_PER_MB) return `${Math.max(1, Math.round(bytes / BYTES_PER_KB))} KB`;
    const megabytes = bytes / BYTES_PER_MB;
    return `${megabytes >= 10 ? Math.round(megabytes) : Number(megabytes.toFixed(1))} MB`;
};
