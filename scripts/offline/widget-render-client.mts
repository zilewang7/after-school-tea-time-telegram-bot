/**
 * Offline cases for the widget render client, the page wrapper and the share
 * card (no containers, no network).
 *
 * A fake fetch stands in for the widget-render sidecar, so every branch —
 * success, timeout, wrong content type, oversized body, bad magic, cache hit —
 * is exercised without Chromium. The module-level default client is left
 * unconfigured (WIDGET_RENDER_URL='') to cover the degraded path.
 *
 * Run: npx tsx scripts/offline/widget-render-client.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';

// Read before the client module is imported: getToolConfig caches on first use
process.env.WIDGET_RENDER_URL = '';

const {
    createWidgetRenderClient,
    renderWidgetPng,
    isWidgetRenderConfigured,
    widgetRenderHealth,
} = await import('../../src/widget-image/render-client.js');
const { widgetDocument, isCompleteHtmlDocument } = await import('../../src/widget-image/widget-page.js');
const { buildShareCardHtml, renderShareCard, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT } = await import(
    '../../src/widget-image/share-card.js'
);
const widgetImage = await import('../../src/widget-image/index.js');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RENDER_BASE_URL = 'http://render.test:8099';

/** A minimal PNG header carrying the given dimensions (enough to parse) */
const pngHeader = (width: number, height: number, totalBytes = 64): Buffer => {
    const png = Buffer.alloc(totalBytes);
    PNG_SIGNATURE.copy(png, 0);
    png.writeUInt32BE(13, 8); // IHDR chunk length
    png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(width, 16);
    png.writeUInt32BE(height, 20);
    return png;
};

const pngResponse = (png: Buffer, status = 200): Response =>
    new Response(png, { status, headers: { 'content-type': 'image/png' } });

interface CapturedRequest {
    readonly url: string;
    readonly body: string;
}

/** Records every request and answers with the given PNG */
const recordingFetch = (png: Buffer): { requests: CapturedRequest[]; fetchImpl: typeof fetch } => {
    const requests: CapturedRequest[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
        requests.push({ url: String(input), body: typeof init?.body === 'string' ? init.body : '' });
        return pngResponse(png);
    };
    return { requests, fetchImpl };
};

const results: CaseResult[] = [];

results.push(
    await runCase('an unconfigured client renders nothing and says why', async () => {
        expect(isWidgetRenderConfigured() === false, 'the default client reports itself unconfigured');
        expect((await renderWidgetPng('<div>hi</div>')) === null, 'renderWidgetPng is a no-op without a sidecar');
        const health = await widgetRenderHealth();
        expect(health.ok === false, 'health is not ok');
        expect(health.detail.includes('WIDGET_RENDER_URL'), 'health detail names the missing setting');
    })
);

results.push(
    await runCase('a successful render parses the PNG size from its header', async () => {
        const { requests, fetchImpl } = recordingFetch(pngHeader(600, 244, 2048));
        const client = createWidgetRenderClient({ baseUrl: `${RENDER_BASE_URL}/`, fetchImpl });
        const result = await client.renderWidgetPng('<div class="card">中文</div>', { width: 600, theme: 'dark' });

        expect(result !== null, 'a valid PNG comes back');
        expect(result?.width === 600 && result?.height === 244, 'the dimensions come from the IHDR header');
        expect(requests.length === 1, 'exactly one request was made');
        expect(
            requests[0]?.url === `${RENDER_BASE_URL}/render?width=600&scale=1&theme=dark`,
            'the trailing slash is trimmed and the query carries width/scale/theme'
        );
        expect(requests[0]?.body.startsWith('<!doctype html>'), 'the fragment is wrapped into a complete document');
        expect(requests[0]?.body.includes('<div class="card">中文</div>'), 'the widget fragment is inside it');
        expect(requests[0]?.body.includes('--tg-theme-bg-color:#17212b'), 'the dark theme variables are injected');
    })
);

results.push(
    await runCase('a complete document is sent unchanged and widths are clamped', async () => {
        const { requests, fetchImpl } = recordingFetch(pngHeader(1200, 630, 4096));
        const client = createWidgetRenderClient({ baseUrl: RENDER_BASE_URL, fetchImpl });
        const fullDocument = '<!doctype html><html><body><p>share card</p></body></html>';
        const result = await client.renderWidgetPng(fullDocument, { width: 10, scale: 2 });

        expect(result?.width === 1200 && result?.height === 630, 'the card size is parsed');
        expect(requests[0]?.body === fullDocument, 'a complete document is not wrapped a second time');
        expect(requests[0]?.url.includes('width=200'), 'a too-small width is clamped to the minimum');
        expect(requests[0]?.url.includes('scale=2'), 'scale 2 is forwarded');
    })
);

results.push(
    await runCase('identical content is served from the cache and copies are isolated', async () => {
        const { requests, fetchImpl } = recordingFetch(pngHeader(600, 244, 1024));
        const client = createWidgetRenderClient({ baseUrl: RENDER_BASE_URL, fetchImpl });

        const first = await client.renderWidgetPng('<div>cached</div>');
        expect(first !== null, 'the first render succeeds');
        if (first !== null) first.png[0] = 0x00; // a caller scribbling on the buffer must not poison the cache

        const second = await client.renderWidgetPng('<div>cached</div>');
        expect(requests.length === 1, 'the second identical render does not hit the sidecar');
        expect(second?.png[0] === 0x89, 'the cached copy still starts with the PNG signature');

        await client.renderWidgetPng('<div>cached</div>', { width: 700 });
        expect(requests.length === 2, 'a different width bypasses the cache');
    })
);

results.push(
    await runCase('a timeout returns null instead of throwing', async () => {
        const hangingFetch: typeof fetch = (_input, init) =>
            new Promise((_resolve, reject) => {
                const signal = init?.signal;
                if (signal === null || signal === undefined) return; // never settles
                signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
            });
        const client = createWidgetRenderClient({ baseUrl: RENDER_BASE_URL, fetchImpl: hangingFetch });
        // AbortSignal.timeout uses an unref'd timer; without another handle the
        // process would exit before the abort fires (in production the bot's own
        // event loop keeps it alive)
        const keepAlive = setInterval(() => {}, 100);
        const startedAt = Date.now();
        try {
            const result = await client.renderWidgetPng('<div>slow</div>', { timeoutMs: 1000 });
            const elapsedMs = Date.now() - startedAt;
            expect(result === null, 'the timeout is reported as null');
            expect(elapsedMs >= 900, `the abort was awaited (${elapsedMs}ms)`);
        } finally {
            clearInterval(keepAlive);
        }
    })
);

results.push(
    await runCase('a non-PNG response is rejected', async () => {
        const jsonFetch: typeof fetch = async () =>
            new Response('{"error":"nope"}', { status: 200, headers: { 'content-type': 'application/json' } });
        const client = createWidgetRenderClient({ baseUrl: RENDER_BASE_URL, fetchImpl: jsonFetch });
        expect((await client.renderWidgetPng('<div>x</div>')) === null, 'a JSON body is not a render result');
    })
);

results.push(
    await runCase('a body without the PNG signature is rejected', async () => {
        const badMagicFetch: typeof fetch = async () =>
            new Response(Buffer.from('this is not a png at all'), {
                status: 200,
                headers: { 'content-type': 'image/png' },
            });
        const client = createWidgetRenderClient({ baseUrl: RENDER_BASE_URL, fetchImpl: badMagicFetch });
        expect((await client.renderWidgetPng('<div>x</div>')) === null, 'a bad magic number is not a render result');
    })
);

results.push(
    await runCase('an oversized PNG is rejected', async () => {
        const oversized = Buffer.alloc(2 * 1024 * 1024 + 1);
        PNG_SIGNATURE.copy(oversized, 0);
        const oversizedFetch: typeof fetch = async () => pngResponse(oversized);
        const client = createWidgetRenderClient({ baseUrl: RENDER_BASE_URL, fetchImpl: oversizedFetch });
        expect((await client.renderWidgetPng('<div>x</div>')) === null, 'a 2 MB+ body is not accepted');
    })
);

results.push(
    await runCase('an HTTP error is rejected', async () => {
        const errorFetch: typeof fetch = async () =>
            new Response('{"error":"render queue is full"}', {
                status: 503,
                headers: { 'content-type': 'application/json' },
            });
        const client = createWidgetRenderClient({ baseUrl: RENDER_BASE_URL, fetchImpl: errorFetch });
        expect((await client.renderWidgetPng('<div>x</div>')) === null, 'a 503 is not a render result');
    })
);

results.push(
    await runCase('health reports the chromium version or the failure reason', async () => {
        const healthyFetch: typeof fetch = async () =>
            new Response(JSON.stringify({ ok: true, chromium: '156.0.8078.79', uptimeMs: 65_000 }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        const healthy = await createWidgetRenderClient({ baseUrl: RENDER_BASE_URL, fetchImpl: healthyFetch }).health();
        expect(healthy.ok, 'a healthy sidecar reports ok');
        expect(healthy.detail.includes('156.0.8078.79'), 'the chromium version is in the detail');
        expect(healthy.detail.includes('uptime 65s'), 'the uptime is in the detail');

        const brokenFetch: typeof fetch = async () =>
            new Response('{"error":"chromium did not expose DevToolsActivePort"}', { status: 503 });
        const broken = await createWidgetRenderClient({ baseUrl: RENDER_BASE_URL, fetchImpl: brokenFetch }).health();
        expect(!broken.ok, 'a 503 is reported as not ok');
        expect(broken.detail.includes('503'), 'the status is in the detail');

        const unreachableFetch: typeof fetch = async () => {
            throw new Error('ECONNREFUSED 127.0.0.1:8099');
        };
        const unreachable = await createWidgetRenderClient({
            baseUrl: RENDER_BASE_URL,
            fetchImpl: unreachableFetch,
        }).health();
        expect(!unreachable.ok && unreachable.detail.includes('ECONNREFUSED'), 'a connection error is surfaced');
    })
);

results.push(
    await runCase('the page wrapper injects theme variables and the height reporter', async () => {
        const light = widgetDocument('<div class="widget">hi</div>');
        expect(light.startsWith('<!doctype html>'), 'a fragment becomes a complete document');
        expect(light.includes('--tg-theme-bg-color:#ffffff'), 'the light palette is injected');
        expect(!light.includes('k-on-bot:widget-height'), 'no reporter unless asked for');

        const dark = widgetDocument('<div class="widget">hi</div>', { theme: 'dark', reportHeight: true });
        expect(dark.includes('--tg-theme-bg-color:#17212b'), 'the dark palette is injected');
        expect(dark.includes('k-on-bot:widget-height'), 'the height reporter is injected');
        expect(
            dark.indexOf('k-on-bot:widget-height') < dark.indexOf('<div class="widget">'),
            'the reporter comes before the widget markup'
        );
        expect(dark.includes('window.parent === window'), 'the reporter is inert outside an iframe');

        const complete = '<!doctype html><html><body><p>card</p></body></html>';
        expect(isCompleteHtmlDocument(complete), 'a doctype document is recognised');
        expect(!isCompleteHtmlDocument('<div>fragment</div>'), 'a fragment is not a document');
        expect(widgetDocument(complete) === complete, 'a complete document is returned unchanged');
    })
);

results.push(
    await runCase('the share card picks widget over image over text and escapes labels', async () => {
        expect(SHARE_CARD_WIDTH === 1200 && SHARE_CARD_HEIGHT === 630, 'the card is 1200x630');

        const html = buildShareCardHtml({
            title: '来自「K-ON 群」的分享',
            subtitle: '第一行 <b>不该被解释</b>',
            footer: 'K-ON 群 · 2026-11-09 13:00',
            widgetPng: pngHeader(1200, 300, 1024),
            imagePng: pngHeader(600, 400, 512),
            textExcerpt: '这段文本不该出现',
        });
        expect(html.includes('width:1200px;height:630px'), 'the document is a fixed 1200x630 page');
        expect(html.includes('k-on-bot · 对话分享'), 'the brand line is part of the template');
        expect(html.includes('data:image/png;base64,'), 'the snapshot is inlined as a data URI');
        expect((html.match(/data:image\/png;base64,/g) ?? []).length === 1, 'only the preferred image is inlined');
        expect(!html.includes('class="excerpt"'), 'the text excerpt is not used when an image exists');
        expect(html.includes('&lt;b&gt;不该被解释&lt;/b&gt;'), 'model/user text is HTML-escaped');
        expect(html.includes('来自「K-ON 群」的分享'), 'the title is rendered as-is when safe');

        const imageOnly = buildShareCardHtml({ title: '图', imagePng: pngHeader(600, 400, 512) });
        expect(imageOnly.includes('data:image/png;base64,'), 'an image attachment is the second choice');

        const textOnly = buildShareCardHtml({ title: '文', textExcerpt: '只有文字的分享内容' });
        expect(textOnly.includes('class="excerpt"'), 'the excerpt is used when there is no image');
        expect(textOnly.includes('只有文字的分享内容'), 'the excerpt text is rendered');
        expect(!textOnly.includes('data:image/png;base64,'), 'no image is inlined without one');

        const longExcerpt = buildShareCardHtml({ title: '长', textExcerpt: '字'.repeat(400) });
        expect(longExcerpt.includes('…'), 'a long excerpt is truncated with an ellipsis');

        const oversizedWidget = Buffer.alloc(200 * 1024, 1);
        PNG_SIGNATURE.copy(oversizedWidget, 0);
        const fallback = buildShareCardHtml({
            title: '大图',
            widgetPng: oversizedWidget,
            imagePng: pngHeader(600, 400, 512),
        });
        expect(fallback.includes('data:image/png;base64,'), 'an oversized snapshot falls back to the attachment');
    })
);

results.push(
    await runCase('renderShareCard degrades to null without a renderer', async () => {
        const result = await renderShareCard({ title: '分享', textExcerpt: '正文' });
        expect(result === null, 'no renderer means no preview card (caller falls back to the 600 image)');
    })
);

results.push(
    await runCase('the index module re-exports the public API', async () => {
        expect(typeof widgetImage.renderWidgetPng === 'function', 'renderWidgetPng is re-exported');
        expect(typeof widgetImage.isWidgetRenderConfigured === 'function', 'isWidgetRenderConfigured is re-exported');
        expect(typeof widgetImage.widgetRenderHealth === 'function', 'widgetRenderHealth is re-exported');
        expect(typeof widgetImage.widgetDocument === 'function', 'widgetDocument is re-exported');
        expect(typeof widgetImage.buildShareCardHtml === 'function', 'buildShareCardHtml is re-exported');
        expect(typeof widgetImage.renderShareCard === 'function', 'renderShareCard is re-exported');
        expect(widgetImage.SHARE_CARD_WIDTH === 1200, 'the card width constant is re-exported');
    })
);

reportResults(results);
