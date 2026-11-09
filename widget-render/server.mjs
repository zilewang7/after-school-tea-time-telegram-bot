/**
 * Headless Chromium PNG renderer for Telegram widget HTML.
 *
 * No npm dependencies: node's built-in WebSocket drives Chromium over the
 * DevTools protocol. One long-lived browser, two render slots, a bounded queue
 * and a per-image timeout; a crashed or wedged browser is killed and relaunched
 * by the next request.
 *
 * Endpoints:
 *   GET  /healthz                                    -> {ok, chromium, uptimeMs, ...}
 *   POST /render?width=600&scale=1&theme=light       -> image/png
 *        body = a complete HTML document (the bot side wraps widget fragments)
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_PATH = process.env.CHROME_PATH ?? '/usr/bin/chromium';
const PORT = Number(process.env.PORT ?? 8099);

/** Telegram widget HTML is capped at 32 KB; the wrapper adds a little, 300 KB is generous */
const MAX_HTML_BYTES = Number(process.env.MAX_HTML_BYTES ?? 300 * 1024);
const MAX_CONCURRENCY = 2;
const MAX_QUEUE = 16;
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS ?? 10_000);
const CDP_TIMEOUT_MS = 12_000;
const LAUNCH_TIMEOUT_MS = 15_000;

/** Telegram bubbles are 200-600 CSS px wide; 1200 is the share-card width */
const MIN_WIDTH = 200;
const MAX_WIDTH = 1600;
const MAX_SCALE = 2;
/** Tall enough for any widget; the screenshot is cropped to the body height */
const VIEWPORT_HEIGHT = 800;
const MAX_PAGE_HEIGHT = 4000;

const FONTS_READY_EXPRESSION =
    'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true';
const PAGE_HEIGHT_EXPRESSION =
    'Math.ceil(Math.max(document.body ? document.body.getBoundingClientRect().height : 0, ' +
    'document.body ? document.body.scrollHeight : 0, 1))';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const startedAt = Date.now();
/** Last Chromium stderr lines, surfaced by /healthz when launching fails */
const chromiumLog = [];
let chromiumProcess = null;
let chromiumProfileDir = null;
/** `{ cdp, version }` once the browser is up */
let browser = null;
/** In-flight launch, so concurrent requests share one browser */
let browserLaunch = null;
let renderCounter = 0;

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
    }
}

const recordChromiumLog = (text) => {
    const line = text.trim();
    if (line === '') return;
    chromiumLog.push(line.slice(0, 300));
    if (chromiumLog.length > 20) chromiumLog.shift();
};

/** One CDP websocket: request/response plus session-scoped events */
class CdpConnection {
    #socket;
    #nextId = 1;
    #pending = new Map();
    #eventHandlers = new Map();
    #closed = false;

    constructor(socket) {
        this.#socket = socket;
        socket.addEventListener('message', (event) => this.#dispatch(String(event.data)));
        socket.addEventListener('close', () => this.#shutdown('CDP connection closed'));
        socket.addEventListener('error', () => this.#shutdown('CDP connection error'));
    }

    static async connect(url, timeoutMs) {
        const socket = new WebSocket(url);
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                socket.close();
                reject(new Error('CDP connect timed out'));
            }, timeoutMs);
            socket.addEventListener('open', () => {
                clearTimeout(timer);
                resolve();
            }, { once: true });
            socket.addEventListener('error', () => {
                clearTimeout(timer);
                reject(new Error('CDP connect failed'));
            }, { once: true });
        });
        return new CdpConnection(socket);
    }

    get closed() {
        return this.#closed;
    }

    send(method, params = {}, sessionId, timeoutMs = CDP_TIMEOUT_MS) {
        if (this.#closed) return Promise.reject(new Error(`CDP closed, cannot send ${method}`));
        const id = this.#nextId;
        this.#nextId += 1;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.#pending.set(id, { resolve, reject, timer, method });
            const payload = sessionId === undefined ? { id, method, params } : { id, method, params, sessionId };
            try {
                this.#socket.send(JSON.stringify(payload));
            } catch (error) {
                clearTimeout(timer);
                this.#pending.delete(id);
                reject(new Error(`CDP send failed: ${errorMessage(error)}`));
            }
        });
    }

    /** Subscribe to an event; returns the unsubscribe function */
    onEvent(method, handler, sessionId) {
        const key = `${sessionId ?? ''}\u0000${method}`;
        const handlers = this.#eventHandlers.get(key) ?? new Set();
        handlers.add(handler);
        this.#eventHandlers.set(key, handlers);
        return () => {
            handlers.delete(handler);
            if (handlers.size === 0) this.#eventHandlers.delete(key);
        };
    }

    /** Resolve with the event params, reject on timeout */
    waitForEvent(method, sessionId, timeoutMs) {
        return new Promise((resolve, reject) => {
            let timer = null;
            let off = () => {};
            const finish = (settle, value) => {
                if (timer === null && off === null) return;
                const settledTimer = timer;
                const settledOff = off;
                timer = null;
                off = null;
                clearTimeout(settledTimer);
                settledOff();
                settle(value);
            };
            timer = setTimeout(() => finish(reject, new Error(`timed out waiting for ${method}`)), timeoutMs);
            off = this.onEvent(method, (params) => finish(resolve, params), sessionId);
        });
    }

    close() {
        if (this.#closed) return;
        this.#shutdown('CDP connection closed by client');
        try {
            this.#socket.close();
        } catch {
            // already gone
        }
    }

    #dispatch(raw) {
        let message;
        try {
            message = JSON.parse(raw);
        } catch {
            return;
        }
        if (message.id !== undefined) {
            const pending = this.#pending.get(message.id);
            if (pending === undefined) return;
            this.#pending.delete(message.id);
            clearTimeout(pending.timer);
            if (message.error) pending.reject(new Error(`CDP ${pending.method}: ${message.error.message}`));
            else pending.resolve(message.result);
            return;
        }
        const key = `${message.sessionId ?? ''}\u0000${message.method}`;
        const handlers = this.#eventHandlers.get(key);
        if (handlers === undefined) return;
        for (const handler of [...handlers]) handler(message.params ?? {});
    }

    #shutdown(reason) {
        if (this.#closed) return;
        this.#closed = true;
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error(`${reason} (${pending.method})`));
        }
        this.#pending.clear();
        this.#eventHandlers.clear();
    }
}

const removeProfileDir = async (dir) => {
    if (dir === null) return;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
};

const stopChromium = async (reason) => {
    const connection = browser?.cdp ?? null;
    const process_ = chromiumProcess;
    browser = null;
    chromiumProcess = null;
    if (connection !== null) connection.close();
    if (process_ === null) return;
    if (process_.exitCode === null && process_.signalCode === null) {
        const exited = new Promise((resolve) => process_.once('exit', resolve));
        process_.kill('SIGKILL');
        await Promise.race([exited, sleep(2000)]);
    }
    console.warn(`[widget-render] chromium stopped (${reason})`);
};

const launchChromium = async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'widget-render-'));
    chromiumProfileDir = profileDir;
    const process_ = spawn(
        CHROME_PATH,
        [
            '--headless=new',
            // No user namespaces inside the container, so Chromium cannot drop
            // its own sandbox; the sidecar has no secrets and no network route.
            '--no-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--hide-scrollbars',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-networking',
            '--disable-component-update',
            '--disable-sync',
            '--disable-extensions',
            '--force-color-profile=srgb',
            `--user-data-dir=${profileDir}`,
            '--remote-debugging-port=0',
            'about:blank',
        ],
        {
            stdio: ['ignore', 'ignore', 'pipe'],
            env: { ...process.env, HOME: profileDir },
        }
    );
    chromiumProcess = process_;
    process_.stderr.on('data', (chunk) => {
        const text = String(chunk);
        recordChromiumLog(text);
        if (text.includes('DevTools listening')) console.log('[widget-render] chromium is listening');
    });
    process_.on('exit', (code, signal) => {
        if (chromiumProcess === process_) {
            chromiumProcess = null;
            browser = null;
        }
        console.warn(`[widget-render] chromium exited code=${code} signal=${signal}`);
        void removeProfileDir(profileDir);
    });

    for (let attempt = 0; attempt < Math.ceil(LAUNCH_TIMEOUT_MS / 100); attempt += 1) {
        if (process_.exitCode !== null || process_.signalCode !== null) {
            throw new Error(`chromium exited during launch (${process_.exitCode ?? process_.signalCode})`);
        }
        try {
            const raw = await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8');
            const [port, path] = raw.trim().split('\n');
            if (port && path) {
                const cdp = await CdpConnection.connect(`ws://127.0.0.1:${port}${path}`, CDP_TIMEOUT_MS);
                const versionInfo = await cdp.send('Browser.getVersion');
                const product = String(versionInfo?.product ?? '');
                const version = product.includes('/') ? product.split('/')[1] : product || 'unknown';
                browser = { cdp, version };
                console.log(`[widget-render] chromium ${version} ready`);
                return browser;
            }
        } catch {
            // DevToolsActivePort is missing until the browser finishes starting
        }
        await sleep(100);
    }
    await stopChromium('launch timeout');
    throw new Error('chromium did not expose DevToolsActivePort');
};

const ensureBrowser = async () => {
    if (browser !== null && !browser.cdp.closed) return browser;
    if (browserLaunch === null) {
        browserLaunch = (async () => {
            try {
                await stopChromium('relaunch');
                return await launchChromium();
            } finally {
                browserLaunch = null;
            }
        })();
    }
    return browserLaunch;
};

const renderPage = async (html, options) => {
    const { width, scale, theme } = options;
    const active = await ensureBrowser();
    const { targetId } = await active.cdp.send('Target.createTarget', { url: 'about:blank' });
    try {
        const { sessionId } = await active.cdp.send('Target.attachToTarget', { targetId, flatten: true });
        await active.cdp.send('Page.enable', {}, sessionId);
        await active.cdp.send(
            'Emulation.setEmulatedMedia',
            { features: [{ name: 'prefers-color-scheme', value: theme }] },
            sessionId
        );
        await active.cdp.send(
            'Emulation.setDeviceMetricsOverride',
            { width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false },
            sessionId
        );

        renderCounter += 1;
        const file = join(tmpdir(), `widget-${process.pid}-${renderCounter}.html`);
        await writeFile(file, html, 'utf8');
        try {
            const loaded = active.cdp.waitForEvent('Page.loadEventFired', sessionId, RENDER_TIMEOUT_MS);
            await active.cdp.send('Page.navigate', { url: `file://${file}` }, sessionId);
            await loaded;
        } finally {
            await rm(file, { force: true });
        }

        // Web fonts and images can settle after the load event
        await active.cdp.send(
            'Runtime.evaluate',
            { expression: FONTS_READY_EXPRESSION, awaitPromise: true },
            sessionId
        );
        await sleep(50);
        const measured = await active.cdp.send(
            'Runtime.evaluate',
            { expression: PAGE_HEIGHT_EXPRESSION, returnByValue: true },
            sessionId
        );
        const measuredHeight = Number(measured?.result?.value);
        const height = Math.min(
            MAX_PAGE_HEIGHT,
            Math.max(1, Math.ceil(Number.isFinite(measuredHeight) ? measuredHeight : 1))
        );
        const screenshot = await active.cdp.send(
            'Page.captureScreenshot',
            {
                format: 'png',
                clip: { x: 0, y: 0, width, height, scale },
                captureBeyondViewport: true,
            },
            sessionId
        );
        return Buffer.from(String(screenshot?.data ?? ''), 'base64');
    } finally {
        await active.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    }
};

const withTimeout = async (promise, timeoutMs) => {
    let timer = null;
    try {
        return await Promise.race([
            promise,
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`render timed out after ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

const queue = [];
let activeRenders = 0;

const drainQueue = () => {
    while (activeRenders < MAX_CONCURRENCY && queue.length > 0) {
        const job = queue.shift();
        activeRenders += 1;
        Promise.resolve()
            .then(job.run)
            .then(job.resolve, job.reject)
            .finally(() => {
                activeRenders -= 1;
                drainQueue();
            });
    }
};

/** A wedged page (infinite script, never-ending layout) is cleared by killing the browser */
const renderWithBudget = async (html, options) => {
    try {
        return await withTimeout(renderPage(html, options), RENDER_TIMEOUT_MS);
    } catch (error) {
        if (errorMessage(error).includes('render timed out')) {
            await stopChromium('render timeout');
        }
        throw error;
    }
};

const enqueueRender = (html, options) =>
    new Promise((resolve, reject) => {
        if (queue.length >= MAX_QUEUE) {
            reject(new HttpError(503, `render queue is full (${MAX_QUEUE})`));
            return;
        }
        queue.push({ run: () => renderWithBudget(html, options), resolve, reject });
        drainQueue();
    });

const parseRenderOptions = (searchParams) => {
    const width = Number.parseInt(searchParams.get('width') ?? '600', 10);
    if (!Number.isInteger(width) || width < MIN_WIDTH || width > MAX_WIDTH) {
        throw new HttpError(400, `width must be an integer in [${MIN_WIDTH}, ${MAX_WIDTH}]`);
    }
    const rawScale = searchParams.get('scale') ?? '1';
    if (rawScale !== '1' && rawScale !== String(MAX_SCALE)) {
        throw new HttpError(400, `scale must be 1 or ${MAX_SCALE}`);
    }
    const theme = (searchParams.get('theme') ?? 'light').trim().toLowerCase();
    if (theme !== 'light' && theme !== 'dark') {
        throw new HttpError(400, 'theme must be light or dark');
    }
    return { width, scale: Number.parseInt(rawScale, 10), theme };
};

const readBody = async (request, limitBytes) => {
    // Answer an obviously oversized upload before buffering any of it
    const declaredLength = Number(request.headers['content-length'] ?? Number.NaN);
    if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
        throw new HttpError(413, `body exceeds ${limitBytes} bytes`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > limitBytes) throw new HttpError(413, `body exceeds ${limitBytes} bytes`);
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
};

const sendJson = (response, status, payload) => {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
    });
    response.end(body);
};

const handleHealth = async (_request, response) => {
    try {
        const active = await ensureBrowser();
        sendJson(response, 200, {
            ok: true,
            chromium: active.version,
            uptimeMs: Date.now() - startedAt,
            activeRenders,
            queued: queue.length,
        });
    } catch (error) {
        sendJson(response, 503, {
            ok: false,
            error: errorMessage(error),
            chromiumLog: chromiumLog.slice(-5),
        });
    }
};

const handleRender = async (request, response, url) => {
    const options = parseRenderOptions(url.searchParams);
    const html = await readBody(request, MAX_HTML_BYTES);
    if (html.trim() === '') throw new HttpError(400, 'body must be a non-empty HTML document');
    const startedRender = Date.now();
    const png = await enqueueRender(html, options);
    if (png.length === 0) throw new Error('chromium returned an empty screenshot');
    console.log(
        `[render] ${options.width}x${options.scale} theme=${options.theme} ` +
            `${Math.ceil(png.length / 1024)}KB in ${Date.now() - startedRender}ms`
    );
    response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': png.length,
        'cache-control': 'no-store',
    });
    response.end(png);
};

const handleRequest = async (request, response) => {
    try {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (request.method === 'GET' && url.pathname === '/healthz') {
            await handleHealth(request, response);
            return;
        }
        if (request.method === 'POST' && url.pathname === '/render') {
            await handleRender(request, response, url);
            return;
        }
        throw new HttpError(404, 'not found');
    } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        if (status >= 500) console.error('[render] failed:', errorMessage(error));
        if (response.headersSent) {
            response.destroy();
            return;
        }
        sendJson(response, status, { error: errorMessage(error) });
        // An oversized body is still streaming in; do not keep the socket alive
        if (status === 413) request.destroy();
    }
};

const server = createServer((request, response) => {
    void handleRequest(request, response);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[widget-render] listening on :${PORT} (chromium ${CHROME_PATH}, concurrency ${MAX_CONCURRENCY})`);
    // Warm the browser so the first real render is not a 1.6s cold start
    void ensureBrowser().catch((error) => console.warn('[widget-render] warmup failed:', errorMessage(error)));
});

const shutdown = async () => {
    server.close();
    await stopChromium('shutdown');
    process.exit(0);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
