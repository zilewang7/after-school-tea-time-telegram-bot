/**
 * SearXNG image search in the shape the reply tools need.
 *
 * The instance (this repo's `searxng` service) answers JSON results whose only
 * reliable fields are `title` / `url` / `img_src` / `thumbnail_src` /
 * `resolution` / `img_format` (2026-10-23: width, height and filesize were empty
 * on all 38 results, while thumbnail_src was there for every one). So sizes are
 * read off `resolution` only, and the model-facing thumbnails are SearXNG's own
 * proxied JPEGs, which also cover animated GIF sources.
 *
 * Results are cached briefly: the same query asked twice inside a reply must not
 * hammer the instance, and the tool layer keeps ids and windows per reply.
 */
import { isJsonObject } from '../shared/json-object.js';

export interface SearchedImage {
    readonly title: string;
    /** The page the image was found on (SearXNG's `url`) */
    readonly sourcePage: string;
    readonly domain: string;
    /** Original image (img_src) */
    readonly imageUrl: string;
    /** SearXNG-proxied thumbnail, always a static JPEG */
    readonly thumbnailUrl: string;
    readonly width?: number;
    readonly height?: number;
    /** Lowercase img_format when the engine reported one */
    readonly format?: string;
    /**
     * How the original can be used: `static` can be sent as a photo and read by
     * a model, `animated` (GIF) can be sent as an animation but reads as one
     * frame, `unsupported` (SVG/unknown) has only its thumbnail.
     */
    readonly sendKind: SendKind;
}

export interface ImageSearchOptions {
    readonly query: string;
    /** SearXNG base URL, e.g. http://searxng:8080 */
    readonly baseUrl: string;
    readonly count: number;
    readonly safesearch: 0 | 1 | 2;
    readonly engines: string;
    readonly signal?: AbortSignal;
}

export type ImageSearchOutcome =
    | {
          readonly ok: true;
          readonly images: readonly SearchedImage[];
          readonly cached: boolean;
      }
    | { readonly ok: false; readonly error: string };

const SEARCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
/** Icon-sized results: both sides under this are not worth showing */
const MIN_ICON_SIDE = 120;
/** A title is a caption, not a paragraph */
const TITLE_MAX_CHARS = 120;

/** rarer kinds of animated/vector/non-photo files we cannot send or read */
const REJECTED_EXTENSIONS: ReadonlySet<string> = new Set([
    'pdf',
    'zip',
    'rar',
    '7z',
    'mp4',
    'webm',
    'mov',
    'avi',
    'mkv',
    'mp3',
    'wav',
    'ogg',
    'html',
    'htm',
    'svg',
    'ico',
    'tif',
    'tiff',
    'bmp',
]);

const STATIC_FORMATS: ReadonlySet<string> = new Set(['png', 'jpeg', 'jpg', 'webp']);
const ANIMATED_FORMATS: ReadonlySet<string> = new Set(['gif']);

/** How a candidate's original can be delivered to the chat */
export type SendKind = 'static' | 'animated' | 'unsupported';

const cache = new Map<string, { readonly expiresAt: number; readonly images: readonly SearchedImage[] }>();

const cacheKeyOf = (options: ImageSearchOptions, query: string): string =>
    `${options.safesearch}|${options.count}|${options.engines}|${query.toLowerCase()}`;

const cacheGet = (key: string): readonly SearchedImage[] | null => {
    const hit = cache.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
        cache.delete(key);
        return null;
    }
    // Refresh insertion order for the LRU eviction below
    cache.delete(key);
    cache.set(key, hit);
    return hit.images;
};

const cachePut = (key: string, images: readonly SearchedImage[]): void => {
    while (cache.size >= CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next();
        if (oldest.done) break;
        cache.delete(oldest.value);
    }
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, images });
};

/** Only for tests: forget everything cached */
export const clearImageSearchCache = (): void => {
    cache.clear();
};

const normalizedQuery = (query: string): string => query.replace(/\s+/g, ' ').trim();

const isHttpUrl = (value: unknown): value is string => {
    if (typeof value !== 'string') return false;
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
};

const extensionOf = (rawUrl: string): string => {
    try {
        const path = new URL(rawUrl).pathname;
        const lastSegment = path.split('/').pop() ?? '';
        const match = /\.([A-Za-z0-9]{1,5})$/.exec(lastSegment);
        return match?.[1]?.toLowerCase() ?? '';
    } catch {
        return '';
    }
};

const domainOf = (rawUrl: string): string => {
    try {
        return new URL(rawUrl).hostname.replace(/^www\./, '');
    } catch {
        return '';
    }
};

const parseResolution = (value: unknown): { width?: number; height?: number } => {
    if (typeof value !== 'string') return {};
    const match = /^(\d{1,5})x(\d{1,5})$/.exec(value.trim());
    if (!match) return {};
    const width = Number.parseInt(match[1] ?? '', 10);
    const height = Number.parseInt(match[2] ?? '', 10);
    return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : {};
};

/**
 * One URL per image: image CDNs add size suffixes (`x.gif!720`, `-640x480`)
 * that point at the same picture, so those are folded before comparing.
 */
const dedupeKeyOf = (rawUrl: string): string => {
    try {
        const url = new URL(rawUrl);
        const path = url.pathname.replace(/!\d+$/, '').replace(/[-_]\d{2,4}x\d{2,4}$/, '');
        return `${url.hostname.toLowerCase()}${path}${url.search}`;
    } catch {
        return rawUrl;
    }
};

const formatOf = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const format = value.trim().toLowerCase();
    if (format === '') return undefined;
    return format === 'jpg' ? 'jpeg' : format;
};

interface CandidateFields {
    readonly title: string;
    readonly sourcePage: string;
    readonly imageUrl: string;
    readonly thumbnailUrl: string;
    readonly resolution: string;
    readonly format: string;
    readonly extension: string;
}

/** Fields that make a result usable; null drops it */
const fieldsOf = (value: unknown): CandidateFields | null => {
    if (!isJsonObject(value)) return null;

    const sourcePage = value.url;
    const imageUrl = value.img_src;
    if (!isHttpUrl(sourcePage) || !isHttpUrl(imageUrl)) return null;

    const extension = extensionOf(imageUrl);
    if (REJECTED_EXTENSIONS.has(extension)) return null;

    const format =
        formatOf(value.img_format) ??
        (STATIC_FORMATS.has(extension) || ANIMATED_FORMATS.has(extension) ? extension : '');
    // A GIF needs its still thumbnail: the original is an animation, and the
    // model is shown (and generate_image references) a static frame
    const thumbnailUrl = isHttpUrl(value.thumbnail_src)
        ? value.thumbnail_src
        : STATIC_FORMATS.has(format)
          ? imageUrl
          : null;
    if (!thumbnailUrl) return null;

    const title = typeof value.title === 'string' ? value.title.trim() : '';
    return {
        title: Array.from(title).slice(0, TITLE_MAX_CHARS).join(''),
        sourcePage,
        imageUrl,
        thumbnailUrl,
        resolution: typeof value.resolution === 'string' ? value.resolution : '',
        format,
        extension,
    };
};

const toSearchedImage = (fields: CandidateFields): SearchedImage | 'icon' => {
    const { width, height } = parseResolution(fields.resolution);
    if (width !== undefined && height !== undefined && width < MIN_ICON_SIDE && height < MIN_ICON_SIDE) {
        return 'icon';
    }

    const sendKind: SendKind = ANIMATED_FORMATS.has(fields.format) || ANIMATED_FORMATS.has(fields.extension)
        ? 'animated'
        : STATIC_FORMATS.has(fields.format) || STATIC_FORMATS.has(fields.extension)
          ? 'static'
          : 'unsupported';
    return {
        title: fields.title || fields.sourcePage,
        sourcePage: fields.sourcePage,
        domain: domainOf(fields.sourcePage),
        imageUrl: fields.imageUrl,
        thumbnailUrl: fields.thumbnailUrl,
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
        ...(fields.format === '' ? {} : { format: fields.format }),
        sendKind,
    };
};

/** The usable results of one response, in SearXNG's relevance order */
const collectImages = (results: readonly unknown[], count: number): SearchedImage[] => {
    const seen = new Set<string>();
    const images: SearchedImage[] = [];

    for (const result of results) {
        if (images.length >= count) break;

        const fields = fieldsOf(result);
        if (!fields) continue;

        const key = dedupeKeyOf(fields.imageUrl);
        if (seen.has(key)) continue;
        seen.add(key);

        const image = toSearchedImage(fields);
        if (image === 'icon') continue;
        images.push(image);
    }

    return images;
};

const fetchSearch = async (
    options: ImageSearchOptions,
    query: string
): Promise<ImageSearchOutcome> => {
    const params = new URLSearchParams({
        q: query,
        categories: 'images',
        format: 'json',
        safesearch: String(options.safesearch),
    });
    if (options.engines) params.set('engines', options.engines);

    const startedAt = Date.now();
    try {
        const response = await fetch(`${options.baseUrl}/search?${params}`, {
            signal: options.signal
                ? AbortSignal.any([options.signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)])
                : AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        });
        if (!response.ok) {
            return { ok: false, error: `图搜服务返回 HTTP ${response.status}` };
        }

        const payload: unknown = await response.json();
        if (!isJsonObject(payload) || !Array.isArray(payload.results)) {
            return { ok: false, error: '图搜服务返回了无法识别的数据' };
        }

        const images = collectImages(payload.results, options.count);
        console.log(
            `[image-search] q="${query}" safesearch=${options.safesearch} engines=${options.engines || '-'} ` +
                `results=${images.length} raw=${payload.results.length} ms=${Date.now() - startedAt} cache=miss`
        );
        return { ok: true, images, cached: false };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ok: false, error: `图搜请求失败：${reason}` };
    }
};

/** Search, or reuse a recent identical search; never throws */
export const searchImages = async (options: ImageSearchOptions): Promise<ImageSearchOutcome> => {
    const query = normalizedQuery(options.query);
    if (query === '') return { ok: false, error: '搜索词不能为空' };

    const key = cacheKeyOf(options, query);
    const cached = cacheGet(key);
    if (cached) {
        console.log(`[image-search] q="${query}" safesearch=${options.safesearch} cache=hit results=${cached.length}`);
        return { ok: true, images: cached, cached: true };
    }

    const outcome = await fetchSearch(options, query);
    if (outcome.ok) cachePut(key, outcome.images);
    return outcome;
};
