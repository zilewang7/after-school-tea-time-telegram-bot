/**
 * Google Cloud Storage service for large media.
 *
 * Large files (> INLINE_MAX_BYTES) are uploaded here and referenced by a gs://
 * URI in Gemini requests, instead of being inlined as base64 (which would bloat
 * the SQLite cache and the request body). Objects are short-lived: a bucket
 * lifecycle rule deletes them after ~2 days, and autoClear removes them (and the
 * cache row) after 1 day.
 *
 * Auth is ADC via GOOGLE_APPLICATION_CREDENTIALS (the mounted service account
 * JSON); the same project's service account can read its own private bucket.
 */
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
    const parsed = /^gs:\/\/([^/]+)\/(.+)$/.exec(gsUri);
    const bucket = parsed?.[1];
    const objectName = parsed?.[2];
    if (!bucket || !objectName) return;
    try {
        await getStorage().bucket(bucket).file(objectName).delete({ ignoreNotFound: true });
    } catch (error) {
        console.error('[gcs] Failed to delete object:', gsUri, error);
    }
};
