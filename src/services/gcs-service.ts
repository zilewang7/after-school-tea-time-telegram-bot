/**
 * Google Cloud Storage service for large media.
 *
 * Large files (> INLINE_MAX_BYTES) are uploaded here and referenced by a gs://
 * URI in Gemini requests, instead of being inlined as base64 (which would bloat
 * the SQLite cache and the request body). Objects are short-lived: autoClear
 * deletes them (and the cache row) after 7 days, the same window as the message
 * rows they belong to. There is no bucket lifecycle rule any more.
 *
 * Auth is ADC via GOOGLE_APPLICATION_CREDENTIALS (the mounted service account
 * JSON); the same project's service account can read its own private bucket.
 */
import type { Readable } from 'node:stream';
import { Storage } from '@google-cloud/storage';

const bucketName = process.env.GCS_BUCKET;

// Lazily constructed so the SDK only initializes ADC when GCS is actually used.
let storageInstance: Storage | null = null;
const getStorage = (): Storage => {
    if (!storageInstance) {
        storageInstance = new Storage();
    }
    return storageInstance;
};

/** Whether GCS-backed large-media storage is configured. */
export const isGcsEnabled = (): boolean => Boolean(bucketName);

const requireBucket = (): string => {
    if (!bucketName) {
        throw new Error('GCS_BUCKET is not set but GCS upload was requested');
    }
    return bucketName;
};

/** bucket + object name of a gs:// URI; null when malformed */
interface GsLocation {
    bucket: string;
    objectName: string;
}

const parseGsUri = (gsUri: string): GsLocation | null => {
    const parsed = /^gs:\/\/([^/]+)\/(.+)$/.exec(gsUri);
    const bucket = parsed?.[1];
    const objectName = parsed?.[2];
    return bucket === undefined || objectName === undefined ? null : { bucket, objectName };
};

/** Byte range of one object; both ends inclusive, as HTTP Range defines them. */
export interface GcsByteRange {
    start: number;
    end: number;
}

/** Stable object name from the content-addressed fileUniqueId. */
const buildObjectName = (fileUniqueId: string): string => {
    const safeId = fileUniqueId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `media/${safeId}`;
};

/** Upload a local file (streamed, not read fully into memory). Returns gs:// URI. */
export const uploadFileToGcs = async (
    localPath: string,
    fileUniqueId: string,
    mime: string
): Promise<string> => {
    const bucket = requireBucket();
    const objectName = buildObjectName(fileUniqueId);
    await getStorage().bucket(bucket).upload(localPath, {
        destination: objectName,
        metadata: { contentType: mime },
    });
    return `gs://${bucket}/${objectName}`;
};

/** Upload in-memory bytes (cloud download path, when there is no local file). */
export const uploadBytesToGcs = async (
    bytes: Buffer,
    fileUniqueId: string,
    mime: string
): Promise<string> => {
    const bucket = requireBucket();
    const objectName = buildObjectName(fileUniqueId);
    await getStorage().bucket(bucket).file(objectName).save(bytes, {
        metadata: { contentType: mime },
        resumable: false,
    });
    return `gs://${bucket}/${objectName}`;
};

/** Delete an object given its gs:// URI. Never throws (best-effort cleanup). */
export const deleteGcsObject = async (gsUri: string): Promise<void> => {
    const location = parseGsUri(gsUri);
    if (location === null) return;
    try {
        await getStorage().bucket(location.bucket).file(location.objectName).delete({ ignoreNotFound: true });
    } catch (error) {
        console.error('[gcs] Failed to delete object:', gsUri, error);
    }
};

/** Size of one stored object in bytes; null when it cannot be read (missing or no ADC). */
export const getGcsObjectSize = async (gsUri: string): Promise<number | null> => {
    const location = parseGsUri(gsUri);
    if (location === null) return null;
    try {
        const [metadata] = await getStorage().bucket(location.bucket).file(location.objectName).getMetadata();
        const size = Number(metadata.size);
        return Number.isFinite(size) ? size : null;
    } catch (error) {
        console.error('[gcs] Failed to read object metadata:', gsUri, error instanceof Error ? error.message : error);
        return null;
    }
};

/**
 * A byte stream of one object (optionally one range), for the panel and the
 * share pages: the browser CSP only allows same-origin media, so large files
 * are proxied instead of redirected to storage.googleapis.com.
 */
export const openGcsReadStream = async (
    gsUri: string,
    range?: GcsByteRange
): Promise<Readable | null> => {
    const location = parseGsUri(gsUri);
    if (location === null) return null;
    try {
        const file = getStorage().bucket(location.bucket).file(location.objectName);
        const stream = range === undefined ? file.createReadStream() : file.createReadStream({ start: range.start, end: range.end });
        return stream;
    } catch (error) {
        console.error('[gcs] Failed to open object stream:', gsUri, error instanceof Error ? error.message : error);
        return null;
    }
};

/**
 * Time-limited read URL for an object, for model APIs that fetch remote media
 * themselves (MiMo takes https URLs, not gs://). Signed with the mounted
 * service account key; returns null on any failure so the caller can drop the
 * attachment instead of sending a dead URL.
 */
export const createSignedReadUrl = async (
    gsUri: string,
    ttlSeconds: number
): Promise<string | null> => {
    const location = parseGsUri(gsUri);
    if (location === null) {
        console.error('[gcs] Cannot sign a malformed URI:', gsUri);
        return null;
    }
    try {
        const [url] = await getStorage().bucket(location.bucket).file(location.objectName).getSignedUrl({
            version: 'v4',
            action: 'read',
            expires: Date.now() + ttlSeconds * 1000,
        });
        return url;
    } catch (error) {
        console.error('[gcs] Failed to sign URL:', gsUri, error instanceof Error ? error.message : error);
        return null;
    }
};
