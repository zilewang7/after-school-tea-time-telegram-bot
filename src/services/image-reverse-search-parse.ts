/**
 * Yandex's reverse-image result page, reduced to the lists the tool shows.
 *
 * The page is server-rendered: the tags, the other sizes, the similar pictures
 * and the pages holding the image each live in a stable `Cbir*` section, so no
 * DOM library or JavaScript execution is needed. Everything here is pure
 * string work, which is also what makes it testable against saved pages.
 *
 * A site entry also carries the picture that page holds (`CbirSites-ItemThumb`)
 * and is marked `[同图]` when that picture appears in the "other sizes" list (by
 * URL or by dimensions); otherwise it stays an unverified source page.
 */
import type {
    ParsedReverseSearch,
    ReverseSearchSite,
    ReverseSearchSimilar,
    ReverseSearchSize,
} from './image-reverse-search-types.js';

/** More than the tool ever shows; keeps a malformed page from blowing up */
const MAX_ITEMS = 40;
const MAX_TAGS = 20;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
    quot: '"',
    amp: '&',
    lt: '<',
    gt: '>',
    apos: "'",
    nbsp: ' ',
};

const ENTITY_PATTERN = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;
const DIMENSION_PATTERN = /(\d{1,5})\s*(?:×|x|на)\s*(\d{1,5})/i;

const entityValue = (body: string): string | null => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
        const code = Number.parseInt(body.slice(2), 16);
        return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
            ? String.fromCodePoint(code)
            : null;
    }
    if (body.startsWith('#')) {
        const code = Number.parseInt(body.slice(1), 10);
        return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
            ? String.fromCodePoint(code)
            : null;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? null;
};

/** Decode the named and numeric entities the page carries */
export const decodeHtmlEntities = (text: string): string =>
    text.replace(ENTITY_PATTERN, (whole: string, body: string): string => entityValue(body) ?? whole);

/** Tags out, entities and whitespace collapsed: one readable line */
export const stripHtml = (html: string): string =>
    decodeHtmlEntities(html.replace(/<[^>]*>/g, ''))
        .replace(/\s+/g, ' ')
        .trim();

const isHttpUrl = (value: string): boolean => {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
};

const domainOf = (rawUrl: string): string => {
    try {
        return new URL(rawUrl).hostname.replace(/^www\./, '');
    } catch {
        return '';
    }
};

/** Tracking parameters add noise and change every visit */
const cleanUrl = (rawUrl: string): string => {
    try {
        const url = new URL(rawUrl);
        // oxlint-disable-next-line no-useless-spread -- the copy is needed: deleting while iterating the live params skips the next key
        for (const key of [...url.searchParams.keys()]) {
            if (key.startsWith('utm_')) url.searchParams.delete(key);
        }
        return url.toString();
    } catch {
        return rawUrl;
    }
};

const attrOf = (attrs: string, name: string): string | undefined => {
    const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
    return match?.[1];
};

/** From a `Cbir*` marker to the next section; '' when the marker is absent */
const sectionOf = (html: string, marker: string): string => {
    const start = html.indexOf(marker);
    if (start < 0) return '';
    const nextSection = html.indexOf('<section', start + marker.length);
    return html.slice(start, nextSection < 0 ? html.length : nextSection);
};

const blockOf = (block: string, terminator: string): string => {
    const end = block.indexOf(terminator);
    return end < 0 ? block : block.slice(0, end);
};

/** host + pathname, lowercased: the same file served through different query strings still matches */
const fileKeyOf = (rawUrl: string): string | null => {
    try {
        const url = new URL(rawUrl);
        return `${url.hostname.replace(/^www\./, '').toLowerCase()}${url.pathname.toLowerCase()}`;
    } catch {
        return null;
    }
};

/** The page's own picture matches a same-size copy: URL or exact dimensions */
const holdsSameImage = (site: ReverseSearchSite, sizes: readonly ReverseSearchSize[]): boolean => {
    const siteKey = site.imageUrl === undefined ? null : fileKeyOf(site.imageUrl);
    if (site.imageUrl !== undefined) {
        for (const size of sizes) {
            const sizeKey = fileKeyOf(size.url);
            if (siteKey !== null && sizeKey !== null) {
                if (siteKey === sizeKey) return true;
                continue;
            }
            // Unparseable URLs fall back to the raw string
            if (site.imageUrl === size.url) return true;
        }
    }
    if (site.width !== undefined && site.height !== undefined) {
        return sizes.some((size) => size.width === site.width && size.height === site.height);
    }
    return false;
};

/** The picture a source page holds, with its dimensions when the page states them */
const thumbOf = (block: string): { readonly imageUrl?: string; readonly width?: number; readonly height?: number } => {
    const anchor = /CbirSites-ItemThumb[^>]*>[\s\S]*?<a\b([^>]*)>/.exec(block);
    const href = anchor === null ? undefined : attrOf(anchor[1] ?? '', 'href');
    const decoded = href === undefined ? undefined : cleanUrl(decodeHtmlEntities(href));
    const usable = decoded !== undefined && isHttpUrl(decoded) ? decoded : undefined;
    const imagePart: { readonly imageUrl?: string } = usable === undefined ? {} : { imageUrl: usable };

    const mark = /Thumb-Mark[^>]*>([\s\S]*?)<\/div>/.exec(block);
    const dimension = mark === null ? null : DIMENSION_PATTERN.exec(stripHtml(mark[1] ?? ''));
    if (dimension === null) return imagePart;

    const width = Number.parseInt(dimension[1] ?? '', 10);
    const height = Number.parseInt(dimension[2] ?? '', 10);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return imagePart;
    return { ...imagePart, width, height };
};

const parseSites = (html: string, sizes: readonly ReverseSearchSize[]): ReverseSearchSite[] => {
    const section = sectionOf(html, 'CbirSitesList');
    if (section === '') return [];

    const sites: ReverseSearchSite[] = [];
    const blocks = section.split(/<li\b[^>]*class="[^"]*\bCbirSites-Item\b[^"]*"[^>]*>/);
    for (const rawBlock of blocks.slice(1)) {
        const block = blockOf(rawBlock, '</li>');
        const titleMatch = /CbirSites-ItemTitle[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/.exec(block);
        if (!titleMatch) continue;

        const href = attrOf(titleMatch[1] ?? '', 'href');
        if (!href) continue;
        const url = cleanUrl(decodeHtmlEntities(href));
        if (!isHttpUrl(url)) continue;
        if (sites.some((site) => site.url === url)) continue;

        const domainMatch = /CbirSites-ItemDomain[^>]*>([\s\S]*?)<\/a>/.exec(block);
        const descriptionMatch = /CbirSites-ItemDescription[^>]*>([\s\S]*?)<\/div>/.exec(block);
        const title = stripHtml(titleMatch[2] ?? '');
        const domain = domainMatch ? stripHtml(domainMatch[1] ?? '') : '';
        const thumb = thumbOf(block);

        const site: ReverseSearchSite = {
            engine: 'yandex',
            match: 'unverified',
            title: title === '' ? domain || url : title,
            url,
            domain: domain === '' ? domainOf(url) : domain,
            description: descriptionMatch ? stripHtml(descriptionMatch[1] ?? '') : '',
            ...thumb,
        };
        sites.push({ ...site, match: holdsSameImage(site, sizes) ? 'exact' : 'unverified' });
        if (sites.length >= MAX_ITEMS) break;
    }
    return sites;
};

const parseSizes = (html: string): ReverseSearchSize[] => {
    const section = sectionOf(html, 'CbirOtherSizes');
    if (section === '') return [];

    const sizes: ReverseSearchSize[] = [];
    for (const anchor of section.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
        const attrs = anchor[1] ?? '';
        const href = attrOf(attrs, 'href');
        if (!href) continue;

        const text = stripHtml(anchor[2] ?? '');
        const dimension = DIMENSION_PATTERN.exec(text) ?? DIMENSION_PATTERN.exec(attrOf(attrs, 'aria-label') ?? '');
        if (!dimension) continue;

        const url = cleanUrl(decodeHtmlEntities(href));
        if (!isHttpUrl(url)) continue;
        if (sizes.some((size) => size.url === url)) continue;

        const width = Number.parseInt(dimension[1] ?? '', 10);
        const height = Number.parseInt(dimension[2] ?? '', 10);
        if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) continue;

        sizes.push({ url, width, height });
        if (sizes.length >= MAX_ITEMS) break;
    }

    return sizes.sort((first, second) => second.width * second.height - first.width * first.height);
};

/** A similar-picture anchor points back at Yandex; the real picture is `img_url` */
const imageUrlOfCbirHref = (href: string): string | undefined => {
    try {
        const url = new URL(decodeHtmlEntities(href), 'https://yandex.com');
        const imageUrl = url.searchParams.get('img_url');
        if (imageUrl === null) return undefined;
        return imageUrl.startsWith('//') ? `https:${imageUrl}` : imageUrl;
    } catch {
        return undefined;
    }
};

const parseSimilar = (html: string): ReverseSearchSimilar[] => {
    const section = sectionOf(html, 'CbirSimilarList');
    if (section === '') return [];

    const similar: ReverseSearchSimilar[] = [];
    for (const block of section.split('class="CbirSimilarList-Thumb"').slice(1)) {
        const href = /<a\b[^>]*\bhref="([^"]*)"/.exec(block)?.[1];
        if (!href) continue;

        const imageUrl = imageUrlOfCbirHref(href);
        if (imageUrl === undefined || !isHttpUrl(imageUrl)) continue;
        if (similar.some((item) => item.imageUrl === imageUrl)) continue;

        const title = stripHtml(decodeHtmlEntities(/aria-label="([^"]*)"/.exec(block)?.[1] ?? ''));
        if (title === '') continue;

        similar.push({ title, imageUrl });
        if (similar.length >= MAX_ITEMS) break;
    }
    return similar;
};

const parseTags = (html: string): string[] => {
    const section = sectionOf(html, 'CbirTags');
    if (section === '') return [];

    const tags: string[] = [];
    const pattern = /class="[^"]*\bTags-Item\b[^"]*"[^>]*>[\s\S]*?<span class="Button-Text">([^<]+)<\/span>/g;
    for (const match of section.matchAll(pattern)) {
        const tag = stripHtml(match[1] ?? '');
        if (tag === '' || tag.toLowerCase() === 'show more') continue;
        if (DIMENSION_PATTERN.test(tag)) continue;
        if (tags.includes(tag)) continue;
        tags.push(tag);
        if (tags.length >= MAX_TAGS) break;
    }
    return tags;
};

const MARKERS = ['CbirTags', 'CbirOtherSizes', 'CbirSimilarList', 'CbirSitesList'] as const;

/** Null when this is not a result page at all (captcha, error page, redesign) */
export const parseReverseSearchHtml = (html: string): ParsedReverseSearch | null => {
    if (!MARKERS.some((marker) => html.includes(marker))) return null;
    const sizes = parseSizes(html);
    return {
        sites: parseSites(html, sizes),
        sizes,
        similar: parseSimilar(html),
        tags: parseTags(html),
    };
};
