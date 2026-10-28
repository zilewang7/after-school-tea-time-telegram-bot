/**
 * Offline cases for search_by_image: the Yandex result page parser, the
 * argument contract, the three picture sources, candidate registration and the
 * failure wording. No network: the service and the image downloads are stubs.
 *
 * Run: npx tsx scripts/offline/reverse-image.mts
 */
import { readFileSync } from 'node:fs';
import {
    expect,
    reportResults,
    runCase,
    setupOfflineDb,
    type CaseResult,
} from './harness.mts';
import type { ContextIndex, ContextIndexEntry } from '../../src/reply/context-index.js';
import type { ReplyToolContext } from '../../src/reply/tools/reply-tool-context.js';
import type { ImageFetch } from '../../src/reply/tools/image-source-download.js';
import type { AnimationFrameLoader } from '../../src/reply/tools/animation-frame.js';
import type { MessageImageLoader } from '../../src/reply/tools/image-references.js';
import type { ParsedReverseSearch } from '../../src/services/image-reverse-search-parse.js';
import type { ReverseSearchOptions, ReverseSearchOutcome } from '../../src/services/image-reverse-search-service.js';

// The platforms build their clients at import time; nothing here sends a request
for (const key of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GROK_API_KEY', 'MIMO_API_KEY']) {
    process.env[key] ||= 'offline-placeholder';
}
await setupOfflineDb();

const { createSearchByImageTool } = await import('../../src/reply/tools/search-by-image-tool.js');
const { createReplyMediaState } = await import('../../src/reply/tools/reply-media-state.js');
const { parseSearchByImageArgs } = await import('../../src/reply/tools/media-tool-args.js');
const { decodeHtmlEntities, parseReverseSearchHtml } = await import(
    '../../src/services/image-reverse-search-parse.js'
);
const { buildCapabilitiesSection } = await import('../../src/ai/system-prompt/sections.js');

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF offline jpeg')]);
const GIF = Buffer.from('GIF89a offline gif');
const NOT_AN_IMAGE = Buffer.from('not an image');

const FIXTURE = readFileSync(new URL('./fixtures/yandex-reverse.html', import.meta.url), 'utf8');

const RESULT: ParsedReverseSearch = {
    sites: [
        {
            title: '来源一 & 标题',
            url: 'https://example.com/page-1',
            domain: 'example.com',
            description: "描述一 'quoted'",
        },
    ],
    sizes: [
        { url: 'https://cdn.example.com/original.jpg?w=5800&h=4350', width: 5800, height: 4350 },
        { url: 'https://cdn.example.com/small.jpg', width: 800, height: 600 },
    ],
    similar: [{ title: '相似图一', imageUrl: 'https://cdn.example.com/similar-1.jpg' }],
    tags: ['собака', 'сиба-ину', 'dog & meme'],
};

const EMPTY_RESULT: ParsedReverseSearch = { sites: [], sizes: [], similar: [], tags: [] };

const entryOf = (data: Buffer, number = 1): ContextIndexEntry => ({
    number,
    messageId: 100 + number,
    fromBot: false,
    images: [{ origin: 'attachment', part: { type: 'image', imageData: data.toString('base64') } }],
    imageCount: 1,
});

const cloudEntryOf = (number = 1): ContextIndexEntry => ({
    number,
    messageId: 100 + number,
    fromBot: false,
    images: [{ origin: 'attachment', part: { type: 'media', mimeType: 'image/jpeg', fileUri: 'gs://bucket/x.jpg' } }],
    imageCount: 1,
});

const contextOf = (contextIndex: ContextIndex): ReplyToolContext => ({
    chatId: -1001,
    chatTitle: '测试群',
    triggerMessageId: 10,
    requester: { userId: 1, name: 'tester' },
    contextIndex,
    signal: new AbortController().signal,
});

interface SearchCall {
    readonly bytes: Buffer;
    readonly mimeType: string;
}

interface SearchStub {
    readonly calls: SearchCall[];
    readonly search: (options: ReverseSearchOptions) => Promise<ReverseSearchOutcome>;
}

const searchStub = (
    result: ParsedReverseSearch = RESULT,
    options: { readonly cached?: boolean; readonly failure?: ReverseSearchOutcome } = {}
): SearchStub => {
    const calls: SearchCall[] = [];
    return {
        calls,
        search: async (searchOptions) => {
            calls.push({ bytes: searchOptions.bytes, mimeType: searchOptions.mimeType });
            if (options.failure !== undefined) return options.failure;
            return {
                ok: true,
                result,
                cached: options.cached === true,
                stats: { uploadMs: 2000, pageMs: 1200, elapsedMs: 3200 },
            };
        },
    };
};

const loadNothing: MessageImageLoader = async () => [];
const noAnimationFrame: AnimationFrameLoader = async () => null;
const fetchImageStub: ImageFetch = async (url) => ({
    ok: true,
    image: { data: JPEG, mimeType: 'image/jpeg', finalUrl: url },
});

const toolOf = (
    index: ContextIndex,
    state = createReplyMediaState(),
    stub = searchStub(),
    fetchImage: ImageFetch = fetchImageStub,
    loadAnimationFrame: AnimationFrameLoader = noAnimationFrame
) => ({
    state,
    stub,
    tool: createSearchByImageTool({
        state,
        context: contextOf(index),
        dependencies: {
            search: stub.search,
            loadMessageImages: loadNothing,
            loadAnimationFrame,
            fetchImage,
        },
    }),
});

const cases: CaseResult[] = [];

cases.push(
    await runCase('the Yandex page parser reads sites, sizes, similar pictures and tags', async () => {
        const parsed = parseReverseSearchHtml(FIXTURE);
        expect(parsed !== null, 'the fixture is a result page');
        if (parsed === null) return;

        expect(parsed.sites.length === 2, `two sites (got ${parsed.sites.length})`);
        expect(parsed.sites[0]?.title === '来源一 & 标题', 'the title is decoded');
        expect(
            parsed.sites[0]?.url === 'https://example.com/page-1',
            `utm_* is stripped (got ${parsed.sites[0]?.url})`
        );
        expect(parsed.sites[0]?.domain === 'example.com', 'the domain is read off the favicon anchor');
        expect(parsed.sites[0]?.description === "描述一 'quoted'", 'the description is decoded');
        expect(parsed.sites[1]?.domain === 'example.org', 'the second domain is read');

        expect(parsed.sizes.length === 2, `duplicate sizes collapse (got ${parsed.sizes.length})`);
        expect(parsed.sizes[0]?.width === 5800 && parsed.sizes[0]?.height === 4350, 'the largest size comes first');
        expect(parsed.sizes[0]?.url.includes('&h=4350'), 'the size URL is entity-decoded');
        expect(parsed.sizes[1]?.width === 800, 'the smaller size follows');

        expect(parsed.similar.length === 2, `empty labels are skipped (got ${parsed.similar.length})`);
        expect(parsed.similar[0]?.title === '相似图一', 'the similar title is read');
        expect(parsed.similar[0]?.imageUrl === 'https://cdn.example.com/similar-1.jpg', 'img_url is decoded');
        expect(parsed.similar[1]?.imageUrl === 'https://cdn.example.com/similar-2.jpg?w=200', 'encoded query is kept');
        expect(parsed.similar[1]?.title === 'Similar & second', 'the similar label is decoded');

        expect(parsed.tags.join('|') === 'собака|сиба-ину|dog & meme', `tags are read (got ${parsed.tags.join('|')})`);
        expect(
            decodeHtmlEntities('&#x27; &amp; &#34;') === "' & \"",
            'named and numeric entities decode'
        );
        expect(parseReverseSearchHtml('<html>not a result</html>') === null, 'a page without Cbir sections is not a result');
    })
);

cases.push(
    await runCase('the description and the prompt line only state what the tool does', async () => {
        const { tool } = toolOf(new Map());
        expect(tool.definition.description.includes('Yandex'), 'the description names the service');
        expect(!tool.definition.description.includes('用户问'), 'the description gives no usage trigger');
        expect(!tool.definition.description.includes('不要用'), 'the description does not police other tools');

        const capabilities = {
            smsOwner: null,
            imageTools: false,
            imageFetch: false,
            imageGenerate: false,
        };
        const on = buildCapabilitiesSection({ ...capabilities, imageReverseSearch: true });
        expect(on.includes('可以用 `search_by_image` 以图搜图'), 'the prompt line names the capability');
        expect(!on.includes('用户问') && !on.includes('不要主动'), 'the prompt line gives no usage instruction');
        const off = buildCapabilitiesSection({ ...capabilities, imageReverseSearch: false });
        expect(!off.includes('search_by_image'), 'the line disappears with the switch');
    })
);

cases.push(
    await runCase('search_by_image takes exactly one picture source', async () => {
        const bad = (args: Record<string, unknown>): boolean => !parseSearchByImageArgs(args).ok;
        expect(bad({}), 'no source is an error');
        expect(bad({ message: 1, image_id: 'img1' }), 'two sources are an error');
        expect(bad({ image: 2 }), 'image without message is an error');
        expect(bad({ image_id: 'bad' }), 'an id must look like img1');
        expect(bad({ message: 0 }), 'message must be positive');

        const fromMessage = parseSearchByImageArgs({ message: 3, image: 2 });
        expect(fromMessage.ok && fromMessage.args.message === 3 && fromMessage.args.image === 2, 'message + image');
        const plain = parseSearchByImageArgs({ message: 3 });
        expect(plain.ok && plain.args.image === undefined, 'image is optional');
        const fetched = parseSearchByImageArgs({ image_id: 'img1' });
        expect(fetched.ok && fetched.args.imageId === 'img1', 'image_id alone');
        const candidate = parseSearchByImageArgs({ search_id: 's3' });
        expect(candidate.ok && candidate.args.searchId === 's3', 'search_id alone');
    })
);

cases.push(
    await runCase('a context picture is searched and its sizes/similar pictures become sN candidates', async () => {
        const index: ContextIndex = new Map([[1, entryOf(PNG)]]);
        const { state, stub, tool } = toolOf(index);
        const result = await tool.execute({ message: 1 }, new AbortController().signal);

        expect(!result.isError, `the call succeeds (${result.content})`);
        expect(stub.calls.length === 1, 'one search');
        expect(stub.calls[0]?.bytes.equals(PNG), 'the message bytes are sent');
        expect(stub.calls[0]?.mimeType === 'image/png', 'the sniffed mime is sent');

        expect(result.content.includes('以图搜图（Yandex，3.2s）'), `the header names the source and time (${result.content})`);
        expect(result.content.includes('来源页 1 条，其他尺寸 2 条，相似图 1 条'), 'the counts are shown');
        expect(result.content.includes('https://example.com/page-1'), 'the source page is shown');
        expect(result.content.includes('5800×4350 — s1'), 'the largest size gets s1');
        expect(result.content.includes('相似图一 — s3'), 'the similar picture gets s3');
        expect(result.content.includes('собака'), 'the tags are shown');

        expect(state.candidates.size === 3, `three candidates are registered (got ${state.candidates.size})`);
        expect(state.candidates.get('s1')?.width === 5800, 's1 is the largest size');
        expect(
            state.candidates.get('s1')?.imageUrl === 'https://cdn.example.com/original.jpg?w=5800&h=4350',
            'the size URL is registered as a candidate'
        );
    })
);

cases.push(
    await runCase('an animated message is searched by its first frame', async () => {
        const entry: ContextIndexEntry = {
            number: 1,
            messageId: 101,
            fromBot: false,
            images: [],
            imageCount: 0,
        };
        const frame = JPEG;
        const { stub, tool } = toolOf(
            new Map([[1, entry]]),
            createReplyMediaState(),
            searchStub(),
            fetchImageStub,
            async () => ({ kind: 'bytes', data: frame })
        );
        const result = await tool.execute({ message: 1 }, new AbortController().signal);

        expect(!result.isError, `the call succeeds (${result.content})`);
        expect(stub.calls.length === 1, 'one search');
        expect(stub.calls[0]?.bytes.equals(frame), 'the first frame is searched, not the video');
        expect(stub.calls[0]?.mimeType === 'image/jpeg', 'the frame mime is sent');
    })
);

cases.push(
    await runCase('the Yandex upload is a sized multipart body, not a chunked one', async () => {
        const { searchByImage, clearReverseSearchCache } = await import(
            '../../src/services/image-reverse-search-service.js'
        );
        clearReverseSearchCache();
        const calls: Array<{ url: string; init: RequestInit }> = [];
        const originalFetch = globalThis.fetch;
        // Undici's chunked FormData upload gets a 200 with no cbirId from Yandex,
        // so the service must send a body it can declare a length for.
        globalThis.fetch = (async (input, init) => {
            calls.push({ url: String(input), init: init ?? {} });
            if (calls.length === 1) {
                return new Response(JSON.stringify({ blocks: [{ params: { cbirId: '123/abc' } }] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            return new Response(FIXTURE, { status: 200, headers: { 'content-type': 'text/html' } });
        }) as typeof fetch;
        try {
            const bytes = Buffer.concat([JPEG, Buffer.from('sized upload probe')]);
            const outcome = await searchByImage({ bytes, mimeType: 'image/jpeg' });
            expect(outcome.ok, `the fake Yandex answers (${outcome.ok ? '' : outcome.error})`);

            const upload = calls[0];
            const headers = new Headers(upload?.init.headers);
            expect(
                headers.get('content-type')?.startsWith('multipart/form-data; boundary=') === true,
                'the body declares its own boundary'
            );
            const declaredLength = Number(headers.get('content-length'));
            const body = upload?.init.body;
            expect(
                body instanceof Uint8Array && declaredLength === body.length,
                `the body length is explicit (${declaredLength} vs ${body instanceof Uint8Array ? body.length : 'n/a'})`
            );
            expect(
                body instanceof Uint8Array && Buffer.from(body).includes(bytes),
                'the image rides inside that body'
            );
        } finally {
            globalThis.fetch = originalFetch;
        }
    })
);

cases.push(
    await runCase('cached results do not consume the three-search budget', async () => {
        const index: ContextIndex = new Map([[1, entryOf(PNG)]]);
        const stub = searchStub(RESULT, { cached: true });
        const { tool } = toolOf(index, createReplyMediaState(), stub);

        for (let call = 0; call < 4; call += 1) {
            const result = await tool.execute({ message: 1 }, new AbortController().signal);
            expect(!result.isError, `cached call ${call + 1} succeeds`);
            expect(result.content.includes('缓存'), 'the header says it came from the cache');
        }
        expect(stub.calls.length === 4, 'every call asked the service (which hit its cache)');
    })
);

cases.push(
    await runCase('three real searches per reply, then the tool stops calling', async () => {
        const index: ContextIndex = new Map([[1, entryOf(PNG)]]);
        const { stub, tool } = toolOf(index);

        for (let call = 0; call < 3; call += 1) {
            const result = await tool.execute({ message: 1 }, new AbortController().signal);
            expect(!result.isError, `search ${call + 1} succeeds`);
        }
        const fourth = await tool.execute({ message: 1 }, new AbortController().signal);
        expect(fourth.isError, 'the fourth search is refused');
        expect(fourth.content.includes('达到上限'), `the limit is named (${fourth.content})`);
        expect(stub.calls.length === 3, 'the service is not called a fourth time');
    })
);

cases.push(
    await runCase('a context picture that cannot be searched says why', async () => {
        const cloud = toolOf(new Map([[1, cloudEntryOf()]]));
        const cloudResult = await cloud.tool.execute({ message: 1 }, new AbortController().signal);
        expect(cloudResult.isError && cloudResult.content.includes('云端'), 'cloud-only pictures are refused');
        expect(cloud.stub.calls.length === 0, 'no upload for a cloud picture');

        const missing = toolOf(new Map());
        const missingResult = await missing.tool.execute({ message: 9 }, new AbortController().signal);
        expect(missingResult.isError && missingResult.content.includes('不在当前上下文里'), 'an unknown #N is refused');

        const badImage = toolOf(new Map([[1, entryOf(NOT_AN_IMAGE)]]));
        const badImageResult = await badImage.tool.execute({ message: 1 }, new AbortController().signal);
        expect(
            badImageResult.isError && badImageResult.content.includes('不是 PNG/JPEG/WebP/GIF'),
            'a non-image is refused'
        );
    })
);

cases.push(
    await runCase('the 8MB cap is checked before the network', async () => {
        const large = Buffer.alloc(9 * 1024 * 1024, 1);
        // Keep the PNG signature so the failure is the size, not the sniff
        PNG.copy(large, 0);
        const index: ContextIndex = new Map([[1, entryOf(large)]]);
        const { stub, tool } = toolOf(index);

        const result = await tool.execute({ message: 1 }, new AbortController().signal);
        expect(result.isError, 'the call is refused');
        expect(result.content.includes('超过以图搜图上限 8MB'), `the cap is named (${result.content})`);
        expect(stub.calls.length === 0, 'nothing was uploaded');
    })
);

cases.push(
    await runCase('image_id and search_id are the other two picture sources', async () => {
        const state = createReplyMediaState();
        state.fetched.set('img1', {
            id: 'img1',
            data: GIF,
            mimeType: 'image/gif',
            still: { data: GIF, mimeType: 'image/gif' },
            sourcePage: 'https://example.com/a.gif',
            imageUrl: 'https://example.com/a.gif',
        });
        const fromFetched = toolOf(new Map(), state);
        const fetchedResult = await fromFetched.tool.execute({ image_id: 'img1' }, new AbortController().signal);
        expect(!fetchedResult.isError, `a fetched GIF can be searched (${fetchedResult.content})`);
        expect(fromFetched.stub.calls[0]?.mimeType === 'image/gif', 'the GIF mime is passed through');

        const candidate = {
            id: 's1',
            searchId: 'q1',
            title: '候选',
            sourcePage: 'https://example.com/page',
            domain: 'example.com',
            imageUrl: 'https://cdn.example.com/candidate.jpg',
            thumbnailUrl: 'https://cdn.example.com/candidate-thumb.jpg',
            sendKind: 'static' as const,
        };
        const state2 = createReplyMediaState();
        state2.candidates.set('s1', candidate);
        const fromCandidate = toolOf(new Map(), state2);
        const candidateResult = await fromCandidate.tool.execute({ search_id: 's1' }, new AbortController().signal);
        expect(!candidateResult.isError, `a search candidate can be searched (${candidateResult.content})`);
        expect(fromCandidate.stub.calls[0]?.bytes.equals(JPEG), 'the downloaded original is sent');
    })
);

cases.push(
    await runCase('an empty page and a service failure keep their own wording', async () => {
        const empty = toolOf(new Map([[1, entryOf(PNG)]]), createReplyMediaState(), searchStub(EMPTY_RESULT));
        const emptyResult = await empty.tool.execute({ message: 1 }, new AbortController().signal);
        expect(!emptyResult.isError, 'an empty result is not a tool error');
        expect(
            emptyResult.content.includes('没有找到来源页、其他尺寸或相似图。'),
            `the empty wording is factual (${emptyResult.content})`
        );
        expect(empty.state.candidates.size === 0, 'no candidates are registered');

        const failed = toolOf(
            new Map([[1, entryOf(PNG)]]),
            createReplyMediaState(),
            searchStub(RESULT, { failure: { ok: false, kind: 'blocked', error: 'Yandex 返回了验证码页面。' } })
        );
        const failedResult = await failed.tool.execute({ message: 1 }, new AbortController().signal);
        expect(failedResult.isError && failedResult.content === 'Yandex 返回了验证码页面。', 'the service error is passed through');
    })
);

reportResults(cases);
