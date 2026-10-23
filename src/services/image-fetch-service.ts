/**
 * Fetching one image for the reply tools, with the safety rails the docs expect:
 * only public http(s) hosts, no credentials, no exotic ports, at most three
 * redirects each re-validated, a hard byte cap and a magic-byte check.
 *
 * DNS is resolved here and every answer is checked, but the connection itself
 * goes through fetch, which resolves again — a rebinding window remains; the
 * byte cap and the format check are what bound the damage.
 */
import { promises as dns } from 'node:dns';
import { isIPv4, isIPv6 } from 'node:net';
import { sniffMediaMime, type SniffedMediaMime } from '../ai/image-generation/image-mime.js';

export interface FetchedImageBytes {
    readonly data: Buffer;
    readonly mimeType: SniffedMediaMime;
    /** After redirects */
    readonly finalUrl: string;
}

export type ImageFetchOutcome =
    | { readonly ok: true; readonly image: FetchedImageBytes }
    | { readonly ok: false; readonly error: string };

export interface ImageFetchOptions {
    /** Hard cap of the downloaded bytes */
    readonly maxBytes: number;
    /** Defaults to 10s */
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

const IPV4_PRIVATE_BLOCKS: ReadonlyArray<readonly [string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
];

const ipv4ToNumber = (address: string): number =>
    address
        .split('.')
        .reduce((value, part) => (value << 8) + Number.parseInt(part, 10), 0) >>> 0;

const isPrivateIpv4 = (address: string): boolean => {
    const value = ipv4ToNumber(address);
    return IPV4_PRIVATE_BLOCKS.some(([block, bits]) => {
        const size = 2 ** (32 - bits);
        const base = ipv4ToNumber(block);
        return value >= base && value < base + size;
    });
};

/** `::ffff:a.b.c.d` is an IPv4 address wearing an IPv6 hat */
const mappedIpv4 = (address: string): string | null => {
    const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
    return match?.[1] ?? null;
};

export const isPrivateAddress = (address: string): boolean => {
    const mapped = mappedIpv4(address);
    if (mapped) return isPrivateIpv4(mapped);

    if (isIPv4(address)) return isPrivateIpv4(address);

    if (isIPv6(address)) {
        const normalized = address.toLowerCase();
        if (normalized === '::' || normalized === '::1') return true;
        // fc00::/7 (unique local), fe80::/10 (link local), ff00::/8 (multicast)
        if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true;
        if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;
        if (/^ff[0-9a-f]{2}:/.test(normalized)) return true;
        return false;
    }

    // Not an IP at all: the caller passes only resolved addresses here
    return true;
};

const hostAllowed = (hostname: string): boolean => {
    const host = hostname.toLowerCase();
    return host !== 'localhost' && !host.endsWith('.localhost');
};

const resolvesToPublicAddress = async (hostname: string): Promise<boolean> => {
    if (!hostAllowed(hostname)) return false;

    // A literal address needs no lookup
    if (isIPv4(hostname) || isIPv6(hostname)) return !isPrivateAddress(hostname);

    try {
        const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
        if (addresses.length === 0) return false;
        return addresses.every((entry) => !isPrivateAddress(entry.address));
    } catch {
        return false;
    }
};

const parseTarget = (rawUrl: string): URL | null => {
    try {
        const url = new URL(rawUrl);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        if (url.username !== '' || url.password !== '') return null;
        if (url.port !== '' && url.port !== '80' && url.port !== '443') return null;
        if (url.hostname === '') return null;
        return url;
    } catch {
        return null;
    }
};

const withTimeout = (options: ImageFetchOptions): AbortSignal => {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
};

const readBody = async (
    response: Response,
    maxBytes: number
): Promise<Buffer | 'too-large' | 'read-failed'> => {
    const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declared) && declared > maxBytes) return 'too-large';

    const body = response.body;
    if (!body) return 'read-failed';

    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let received = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            received += value.byteLength;
            if (received > maxBytes) {
                await reader.cancel();
                return 'too-large';
            }
            chunks.push(Buffer.from(value));
        }
    } catch {
        await reader.cancel().catch(() => undefined);
        return 'read-failed';
    }
    return Buffer.concat(chunks);
};

/** Download one image; never throws */
export const fetchImageBytes = async (
    rawUrl: string,
    options: ImageFetchOptions
): Promise<ImageFetchOutcome> => {
    const signal = withTimeout(options);
    const startedAt = Date.now();
    let current = parseTarget(rawUrl);

    if (!current) return { ok: false, error: '这不是一个可读取的 http(s) 图片地址' };

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (!(await resolvesToPublicAddress(current.hostname))) {
            console.log(`[image-fetch] blocked host=${current.hostname}`);
            return { ok: false, error: '这个地址指向内网或本机，不能读取' };
        }

        let response: Response;
        try {
            response = await fetch(current, {
                redirect: 'manual',
                signal,
                headers: { accept: 'image/*' },
            });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return { ok: false, error: `下载图片失败：${reason}` };
        }

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) return { ok: false, error: '图片地址重定向但没有给出目标' };
            try {
                current = parseTarget(new URL(location, current).toString());
            } catch {
                current = null;
            }
            if (!current) return { ok: false, error: '图片地址重定向到了不支持的地址' };
            continue;
        }

        if (!response.ok) {
            return { ok: false, error: `图床返回 HTTP ${response.status}` };
        }

        const body = await readBody(response, options.maxBytes);
        if (body === 'too-large') {
            return { ok: false, error: `图片超过 ${Math.round(options.maxBytes / 1024 / 1024)}MB 上限` };
        }
        if (body === 'read-failed') return { ok: false, error: '图片下载中断' };

        const mimeType = sniffMediaMime(body);
        if (!mimeType) return { ok: false, error: '链接内容不是 PNG/JPEG/WebP/GIF 图片' };

        console.log(
            `[image-fetch] host=${current.hostname} status=${response.status} mime=${mimeType} ` +
                `bytes=${body.length} ms=${Date.now() - startedAt}`
        );
        return { ok: true, image: { data: body, mimeType, finalUrl: current.toString() } };
    }

    return { ok: false, error: '图片地址重定向次数太多' };
};
