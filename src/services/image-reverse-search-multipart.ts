/**
 * A multipart/form-data body with an explicit Content-Length.
 *
 * `FormData` is left out on purpose: with the global undici fetch it goes out
 * chunked, and Yandex then answers 200 with an empty `params` block instead of
 * a cbirId (verified 2026-10-27 — the same bytes with a sized body work).
 * SauceNAO's upload is sent the same way, so no engine depends on how undici
 * frames a stream.
 */
import { randomUUID } from 'node:crypto';

export interface MultipartFile {
    /** The form field name the endpoint expects, e.g. `upfile` */
    readonly field: string;
    readonly filename: string;
    readonly mimeType: string;
    readonly data: Buffer;
}

export interface MultipartText {
    readonly field: string;
    readonly value: string;
}

export interface MultipartBody {
    readonly body: Buffer;
    readonly contentType: string;
}

export const buildMultipartBody = (
    files: readonly MultipartFile[],
    texts: readonly MultipartText[] = []
): MultipartBody => {
    const boundary = `----k-on-bot-${randomUUID()}`;
    const parts: Buffer[] = [];

    for (const text of texts) {
        parts.push(
            Buffer.from(
                `--${boundary}\r\n` +
                    `Content-Disposition: form-data; name="${text.field}"\r\n\r\n` +
                    `${text.value}\r\n`
            )
        );
    }
    for (const file of files) {
        parts.push(
            Buffer.from(
                `--${boundary}\r\n` +
                    `Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
                    `Content-Type: ${file.mimeType}\r\n\r\n`
            ),
            file.data,
            Buffer.from('\r\n')
        );
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    return {
        body: Buffer.concat(parts),
        contentType: `multipart/form-data; boundary=${boundary}`,
    };
};
