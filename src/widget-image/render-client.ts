/**
 * Client for the widget-render sidecar.
 *
 * The sidecar renders a complete HTML document to a PNG (headless Chromium, see
 * widget-render/server.mjs). Widget HTML is a fragment, so it is wrapped by
 * widget-page.ts first; a complete document is sent as-is (share cards). Results
 * are cached by content hash — retries and version switches re-render the same
 * card — and every failure is logged and reported as null: a missing preview
 * must never break a reply.
 */
import { createHash } from 'node:crypto';
import { getToolConfig } from '../config/tool-config.js';
import { isJsonObject } from '../shared/json-object.js';
import { widgetDocument, type WidgetTheme } from './widget-page.js';

export interface RenderOptions {
    /** CSS pixel viewport width; 600 matches a Telegram bubble, 1200 a share card */
    readonly width?: number;
    /** Device pixel ratio of the screenshot */
    readonly scale?: 1 | 2;
    /** Colour scheme handed to the page (and emulated as prefers-color-scheme) */
    readonly theme?: WidgetTheme;
    /** Whole-request budget; the sidecar has its own 10s render budget */
    readonly timeoutMs?: number;
}

export interface RenderResult {
    readonly png: Buffer;
    /** Pixel width of the PNG (width * scale), not the CSS width that was requested */
    readonly width: number;
    readonly height: number;
}

export interface WidgetRenderHealth {
    readonly ok: boolean;
    /** Human-readable state for logs and /widget_status; never contains secrets */
    readonly detail: string;
}

export interface WidgetRenderClientOptions {
    /** Sidecar base URL, e.g. http://widget-render:8099; empty disables rendering */
    readonly baseUrl: string;
    /** Test hook */
    readonly fetchImpl?: typeof fetch;
}

export interface WidgetRenderClient {
    readonly renderWidgetPng: (html: string, options?: RenderOptions) => Promise<RenderResult | null>;
    readonly isConfigured: () => boolean;
    readonly health: () => Promise<WidgetRenderHealth>;
}

const DEFAULT_WIDTH = 600;
const MIN_WIDTH = 200;
const MAX_WIDTH = 1600;
const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 5_000;
const MAX_PNG_BYTES = 2 * 1024 * 1024;
const MAX_PNG_DIMENSION = 4096;
const CACHE_LIMIT = 32;
const CACHE_TTL_MS = 10 * 60 * 1000;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR_TYPE = 0x49484452; // 'IHDR'

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Extra detail for a failed response body; empty when there is none */
const responseDetail = async (response: Response): Promise<string> => {
    const text = await response.text().catch(() => '');
    const trimmed = text.trim();
    return trimmed === '' ? '' : ` ${trimmed.slice(0, 200)}`;
};

const readPngSize = (png: Buffer): { width: number; height: number } | null => {
    if (png.length < 24) return null;
    if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
    if (png.readUInt32BE(12) !== IHDR_TYPE) return null;
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    if (width <= 0 || height <= 0 || width > MAX_PNG_DIMENSION || height > MAX_PNG_DIMENSION) return null;
    return { width, height };
};

const normalizeWidth = (width: number | undefined): number => {
    if (width === undefined || !Number.isFinite(width)) return DEFAULT_WIDTH;
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
};

const normalizeTimeout = (timeoutMs: number | undefined): number => {
    if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS;
    return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(timeoutMs)));
};

interface CacheEntry {
    readonly result: RenderResult;
    readonly expiresAt: number;
}

/** Content-hash cache: Map insertion order doubles as the LRU order */
const renderCache = new Map<string, CacheEntry>();

const renderCacheKey = (document: string, width: number, scale: number, theme: WidgetTheme): string =>
    createHash('sha256').update(`${width}\u0000${scale}\u0000${theme}\u0000${document}`).digest('hex');

const copyResult = (result: RenderResult): RenderResult => ({
    png: Buffer.from(result.png),
    width: result.width,
    height: result.height,
});

const readCachedResult = (key: string): RenderResult | null => {
    const entry = renderCache.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= Date.now()) {
        renderCache.delete(key);
        return null;
    }
    renderCache.delete(key);
    renderCache.set(key, entry);
    return copyResult(entry.result);
};

const writeCachedResult = (key: string, result: RenderResult): void => {
    if (renderCache.size >= CACHE_LIMIT) {
        const oldest = renderCache.keys().next();
        if (oldest.done !== true) renderCache.delete(oldest.value);
    }
    renderCache.set(key, { result: copyResult(result), expiresAt: Date.now() + CACHE_TTL_MS });
};

const describeHealth = (payload: unknown): WidgetRenderHealth => {
    if (!isJsonObject(payload)) return { ok: false, detail: 'invalid /healthz payload' };
    const chromium = typeof payload.chromium === 'string' ? payload.chromium : 'unknown';
    if (payload.ok !== true) {
        const reason = typeof payload.error === 'string' ? payload.error : 'not ok';
        return { ok: false, detail: `${reason} (chromium ${chromium})` };
    }
    const uptimeMs = typeof payload.uptimeMs === 'number' ? payload.uptimeMs : null;
    const uptime = uptimeMs === null ? '' : `, uptime ${Math.round(uptimeMs / 1000)}s`;
    return { ok: true, detail: `chromium ${chromium}${uptime}` };
};

export const createWidgetRenderClient = (options: WidgetRenderClientOptions): WidgetRenderClient => {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
    const fetchImpl = options.fetchImpl ?? fetch;

    const renderWidgetPng = async (html: string, renderOptions: RenderOptions = {}): Promise<RenderResult | null> => {
        if (baseUrl === '') return null;
        if (html.trim() === '') return null;

        const width = normalizeWidth(renderOptions.width);
        const scale: 1 | 2 = renderOptions.scale === 2 ? 2 : 1;
        const theme: WidgetTheme = renderOptions.theme === 'dark' ? 'dark' : 'light';
        const timeoutMs = normalizeTimeout(renderOptions.timeoutMs);
        const document = widgetDocument(html, { theme });

        const cacheKey = renderCacheKey(document, width, scale, theme);
        const cached = readCachedResult(cacheKey);
        if (cached !== null) return cached;

        const startedAt = Date.now();
        try {
            const response = await fetchImpl(`${baseUrl}/render?width=${width}&scale=${scale}&theme=${theme}`, {
                method: 'POST',
                headers: { 'content-type': 'text/html; charset=utf-8' },
                body: document,
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!response.ok) {
                console.warn(`[widget-image] render failed: HTTP ${response.status}${await responseDetail(response)}`);
                return null;
            }
            const contentType = response.headers.get('content-type') ?? '';
            if (!contentType.includes('image/png')) {
                console.warn(`[widget-image] render failed: unexpected content-type ${contentType || '(none)'}`);
                return null;
            }
            const png = Buffer.from(await response.arrayBuffer());
            if (png.length === 0) {
                console.warn('[widget-image] render failed: empty PNG');
                return null;
            }
            if (png.length > MAX_PNG_BYTES) {
                console.warn(`[widget-image] render failed: PNG is ${png.length} bytes (limit ${MAX_PNG_BYTES})`);
                return null;
            }
            const size = readPngSize(png);
            if (size === null) {
                console.warn('[widget-image] render failed: response is not a valid PNG');
                return null;
            }
            const result: RenderResult = { png, width: size.width, height: size.height };
            writeCachedResult(cacheKey, result);
            console.log(
                `[widget-image] rendered ${size.width}x${size.height} ${Math.ceil(png.length / 1024)}KB in ${Date.now() - startedAt}ms`
            );
            return result;
        } catch (error) {
            console.warn(`[widget-image] render failed: ${errorMessage(error)}`);
            return null;
        }
    };

    const health = async (): Promise<WidgetRenderHealth> => {
        if (baseUrl === '') return { ok: false, detail: 'WIDGET_RENDER_URL is not set' };
        try {
            const response = await fetchImpl(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
            if (!response.ok) {
                return { ok: false, detail: `HTTP ${response.status}${await responseDetail(response)}` };
            }
            return describeHealth(await response.json());
        } catch (error) {
            return { ok: false, detail: errorMessage(error) };
        }
    };

    return { renderWidgetPng, isConfigured: () => baseUrl !== '', health };
};

let defaultClient: WidgetRenderClient | undefined;

const defaultWidgetRenderClient = (): WidgetRenderClient => {
    defaultClient ??= createWidgetRenderClient({ baseUrl: getToolConfig().widgetRenderUrl });
    return defaultClient;
};

/** Render widget HTML (fragment or complete document) to a PNG; null on any failure */
export const renderWidgetPng = (html: string, options?: RenderOptions): Promise<RenderResult | null> =>
    defaultWidgetRenderClient().renderWidgetPng(html, options);

/** False when WIDGET_RENDER_URL is empty: every render call is a no-op */
export const isWidgetRenderConfigured = (): boolean => defaultWidgetRenderClient().isConfigured();

/** Probe the sidecar; never throws */
export const widgetRenderHealth = (): Promise<WidgetRenderHealth> => defaultWidgetRenderClient().health();
