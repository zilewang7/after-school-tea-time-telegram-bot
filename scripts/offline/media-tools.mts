/**
 * Offline cases for the media tools: search paging, budgets, the shared
 * one-image rule, fetch once / read twice, the download safety rails, how the
 * instance's unusual result fields are read, and the per-platform replay of
 * model-only images.
 *
 * Run: npx tsx scripts/offline/media-tools.mts
 *
 * No database, no network: the tools take their search/download functions by
 * injection, and the search service's one fetch is a stubbed global.
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';

// The platforms build their clients at import time; nothing here sends a request
for (const key of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GROK_API_KEY', 'MIMO_API_KEY']) {
    process.env[key] ||= 'offline-placeholder';
}
import type { ExecutedToolCall } from '../../src/ai/tools/tool-round.js';
import type { ImageSearchOptions, ImageSearchOutcome } from '../../src/services/image-search-service.js';
import type { ToolCall, ToolResult } from '../../src/ai/tools/tool-types.js';

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);

const replyTools = await import('../../src/reply/tools/index.js');
const searchService = await import('../../src/services/image-search-service.js');
const fetchService = await import('../../src/services/image-fetch-service.js');

const {
    createReplyMediaState,
    createSearchImagesTool,
    createFetchImageTool,
    createSendImageTool,
    createGenerateImageTool,
    MAX_IMAGE_SEARCHES,
    MAX_IMAGE_FETCHES,
} = replyTools;

const candidateJson = (index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    title: `候选 ${index}`,
    url: `https://example.com/page-${index}`,
    img_src: `https://cdn.example.com/img-${index}.jpg`,
    thumbnail_src: `https://cdn.example.com/thumb-${index}.jpg`,
    resolution: '640x480',
    img_format: 'JPG',
    engines: ['google cse images'],
    ...overrides,
});

const searchedImages = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
        title: `候选 ${index + 1}`,
        sourcePage: `https://example.com/page-${index + 1}`,
        domain: 'example.com',
        imageUrl: `https://cdn.example.com/img-${index + 1}.jpg`,
        thumbnailUrl: `https://cdn.example.com/thumb-${index + 1}.jpg`,
        width: 640,
        height: 480,
        format: 'jpeg',
        originalSendable: true,
    }));

interface SearchStub {
    readonly search: (options: ImageSearchOptions) => Promise<ImageSearchOutcome>;
    readonly calls: string[];
}

const searchStub = (count = 8): SearchStub => {
    const calls: string[] = [];
    return {
        calls,
        search: async (options) => {
            calls.push(options.query);
            return { ok: true, images: searchedImages(count), cached: false };
        },
    };
};

const thumbnailStub = () => ({
    ok: true as const,
    image: { data: PNG, mimeType: 'image/png' as const, finalUrl: 'https://cdn.example.com/thumb.jpg' },
});

const searchToolWith = (
    state: ReturnType<typeof createReplyMediaState>,
    stub: SearchStub,
    options: { canSeeImages?: boolean } = {}
) =>
    createSearchImagesTool({
        state,
        dependencies: {
            search: stub.search,
            fetchThumbnail: async () => thumbnailStub(),
            baseUrl: 'http://searxng:8080',
            engines: '',
            safesearch: 1,
            canSeeImages: options.canSeeImages ?? true,
        },
    });

const toolCall = (name: string, args: Record<string, unknown>, id = 'call_1'): ToolCall => ({
    id,
    name,
    argumentsJson: JSON.stringify(args),
});

const modelImageResult = (): ToolResult => ({
    content: '搜到了 3 张图，附在下面。',
    isError: false,
    images: [],
    modelImages: [{ data: PNG, mimeType: 'image/png', caption: '[s1] 示例图 — example.com' }],
    record: null,
});

const executedWithModelImage = (): ExecutedToolCall => ({
    call: toolCall('search_images', { query: '狗头' }),
    result: modelImageResult(),
});

const cases = [
    {
        name: 'search_images shows three first, then everything that is left',
        body: async (): Promise<void> => {
            const state = createReplyMediaState(null);
            const stub = searchStub();
            const tool = searchToolWith(state, stub);

            const first = await tool.execute({ query: '狗头表情包' }, AbortSignal.abort());
            expect(!first.isError, `the first search succeeds (got ${first.content})`);
            expect(first.modelImages?.length === 3, `three thumbnails (got ${first.modelImages?.length ?? 0})`);
            expect(first.content.includes('还没看：s4 s5 s6 s7 s8'), 'the text names what is unseen');
            expect(first.content.includes("search_images(search='q1')"), 'and how to see it');

            const second = await tool.execute({ search: 'q1' }, AbortSignal.abort());
            expect(second.modelImages?.length === 5, `the rest comes at once (got ${second.modelImages?.length ?? 0})`);
            expect(state.thumbnailCount === 8, `all eight thumbnails were spent (got ${state.thumbnailCount})`);
            expect(second.content.includes('这批缩略图都看过了'), 'the text says the batch is done');
            expect(
                second.content.includes('必须用 send_image'),
                'after a full batch the tool tells the model to send instead of searching again'
            );

            const third = await tool.execute({ search: 'q1' }, AbortSignal.abort());
            expect(third.isError && third.content.includes('都看过了'), 'asking again is an error that explains');
            expect(stub.calls.length === 1, `SearXNG was hit once (got ${stub.calls.length})`);
        },
    },
    {
        name: 'a second query after the first search comes back with all eight',
        body: async (): Promise<void> => {
            const state = createReplyMediaState(null);
            const stub = searchStub();
            const tool = searchToolWith(state, stub);

            await tool.execute({ query: '第一个关键词' }, AbortSignal.abort());
            const second = await tool.execute({ query: '第二个关键词' }, AbortSignal.abort());
            expect(second.modelImages?.length === 8, `the second search shows all eight (got ${second.modelImages?.length ?? 0})`);
            expect(state.searches.size === 2, 'two search sets');
            expect(
                [...state.candidates.keys()].slice(0, 3).join(',') === 's1,s2,s3' &&
                    [...state.candidates.keys()].at(-1) === 's16',
                'candidate ids keep counting across searches'
            );
            expect(stub.calls.join('|') === '第一个关键词|第二个关键词', 'each query hit the service once');
        },
    },
    {
        name: 'details never attaches pictures and does not consume the first window',
        body: async (): Promise<void> => {
            const state = createReplyMediaState(null);
            const tool = searchToolWith(state, searchStub());

            const details = await tool.execute({ query: '狗头表情包', view: 'details' }, AbortSignal.abort());
            expect(!details.modelImages || details.modelImages.length === 0, 'no pictures in details');
            expect(details.content.includes('https://example.com/page-1'), 'but the source page is listed');
            expect(state.thumbnailCount === 0, 'the thumbnail window is untouched');

            const pictureCall = await tool.execute({ query: '狗头表情包' }, AbortSignal.abort());
            expect(
                pictureCall.modelImages?.length === 3 && state.thumbnailCount === 3,
                'the first picture call still gets the three-picture window'
            );
        },
    },
    {
        name: 'a text-only model gets metadata and no pictures',
        body: async (): Promise<void> => {
            const state = createReplyMediaState(null);
            const stub = searchStub();
            const tool = searchToolWith(state, stub, { canSeeImages: false });

            const result = await tool.execute({ query: '狗头表情包' }, AbortSignal.abort());
            expect(!result.modelImages || result.modelImages.length === 0, 'no model images');
            expect(result.content.includes('你看不到图'), 'the text says why');
            expect(!result.content.includes('已附缩略图'), 'and does not promise pictures');
            expect(state.thumbnailCount === 0, 'nothing counted against the thumbnail budget');
        },
    },
    {
        name: 'one reply gets one picture, shared by send_image and generate_image',
        body: async (): Promise<void> => {
            const state = createReplyMediaState(null);
            const tool = searchToolWith(state, searchStub());
            await tool.execute({ query: '狗头表情包' }, AbortSignal.abort());

            const send = createSendImageTool({
                state,
                context: { chatId: -100, contextIndex: new Map(), signal: AbortSignal.abort() },
                dependencies: {
                    fetchImage: async () => ({
                        ok: true,
                        image: { data: PNG, mimeType: 'image/png', finalUrl: 'https://cdn.example.com/img-1.jpg' },
                    }),
                    loadMessageImages: async () => [],
                },
            });
            const first = await send.execute({ search_id: 's1' }, AbortSignal.abort());
            expect(!first.isError && first.images.length === 1, `the first send goes out (got ${first.content})`);

            const second = await send.execute({ search_id: 's2' }, AbortSignal.abort());
            expect(second.isError && second.content.includes('已经有一张图'), 'a second send is refused');

            const draw = createGenerateImageTool(
                {
                    chatId: -100,
                    chatTitle: '测试群',
                    triggerMessageId: 1,
                    requester: { userId: 42, name: '张三' },
                    contextIndex: new Map(),
                    triggerText: null,
                    signal: AbortSignal.abort(),
                },
                state,
                {
                    sendMessage: async () => {
                        throw new Error('must not be called');
                    },
                    loadMessageImages: async () => [],
                    fetchImage: async () => ({ ok: false, error: 'offline' }),
                }
            );
            const drawing = await draw.execute({ prompt: '一只狗', caption: '' }, AbortSignal.abort());
            expect(drawing.isError && drawing.content.includes('已经有一张图'), 'drawing is refused too');
        },
    },
    {
        name: 'fetch_image reads once, re-reading is free, and the budget is four',
        body: async (): Promise<void> => {
            const state = createReplyMediaState(null);
            const tool = searchToolWith(state, searchStub());
            await tool.execute({ query: '狗头表情包' }, AbortSignal.abort());

            const fetch = createFetchImageTool({
                state,
                dependencies: {
                    fetchImage: async () => ({
                        ok: true,
                        image: { data: PNG, mimeType: 'image/png', finalUrl: 'https://cdn.example.com/img-1.jpg' },
                    }),
                },
            });

            const read = await fetch.execute({ search_id: 's1' }, AbortSignal.abort());
            expect(!read.isError && read.modelImages?.length === 1, `one image comes back (got ${read.content})`);
            expect(read.content.includes('img1'), 'and it is numbered img1');

            const reread = await fetch.execute({ image_id: 'img1' }, AbortSignal.abort());
            expect(!reread.isError && (!reread.modelImages || reread.modelImages.length === 0), 're-reading sends no bytes again');
            expect(state.fetchCount === 1, `re-reading is free (fetch count ${state.fetchCount})`);

            for (const candidateId of ['s2', 's3', 's4']) {
                await fetch.execute({ search_id: candidateId }, AbortSignal.abort());
            }
            const overBudget = await fetch.execute({ search_id: 's5' }, AbortSignal.abort());
            expect(
                overBudget.isError && overBudget.content.includes('已经读取'),
                `the fifth read is refused (got ${overBudget.content})`
            );
            expect(state.fetchCount === MAX_IMAGE_FETCHES, `the budget is ${MAX_IMAGE_FETCHES}`);
        },
    },
    {
        name: 'the search budget is two searches per reply',
        body: async (): Promise<void> => {
            const state = createReplyMediaState(null);
            const tool = searchToolWith(state, searchStub());
            for (const query of ['a', 'b']) {
                await tool.execute({ query }, AbortSignal.abort());
            }
            const refused = await tool.execute({ query: 'c' }, AbortSignal.abort());
            expect(refused.isError && refused.content.includes('搜了 2 次'), 'the third search is refused');
            expect(state.searchCount === MAX_IMAGE_SEARCHES, 'and the count is the limit');
        },
    },
    {
        name: 'the download safety rails refuse loopback and metadata addresses',
        body: async (): Promise<void> => {
            expect(fetchService.isPrivateAddress('127.0.0.1'), 'loopback is private');
            expect(fetchService.isPrivateAddress('10.1.2.3'), '10/8 is private');
            expect(fetchService.isPrivateAddress('169.254.169.254'), 'the metadata address is private');
            expect(fetchService.isPrivateAddress('::1'), 'IPv6 loopback is private');
            expect(fetchService.isPrivateAddress('fd00::1'), 'unique-local IPv6 is private');
            expect(fetchService.isPrivateAddress('::ffff:192.168.1.1'), 'mapped IPv4 is checked');
            expect(!fetchService.isPrivateAddress('93.184.216.34'), 'a public IPv4 is fine');

            const loopback = await fetchService.fetchImageBytes('http://127.0.0.1:80/a.png', { maxBytes: 1024 });
            expect(!loopback.ok && loopback.error.includes('内网'), 'fetching loopback is refused');
            const wrongScheme = await fetchService.fetchImageBytes('file:///etc/passwd', { maxBytes: 1024 });
            expect(!wrongScheme.ok, 'only http(s) is accepted');
            const localhost = await fetchService.fetchImageBytes('http://localhost/a.png', { maxBytes: 1024 });
            expect(!localhost.ok, 'localhost is refused');
        },
    },
    {
        name: "the search service reads this instance's real fields",
        body: async (): Promise<void> => {
            searchService.clearImageSearchCache();
            const originalFetch = globalThis.fetch;
            const payload = {
                results: [
                    // No width/height/filesize; only resolution and thumbnail_src
                    candidateJson(1, { img_format: 'gif', img_src: 'https://cdn.example.com/doge.gif', resolution: '' }),
                    candidateJson(2, { img_src: 'https://cdn.example.com/doge.gif!720' }),
                    candidateJson(3, { img_src: 'https://cdn.example.com/doge.gif' }),
                    candidateJson(4, { img_src: 'https://cdn.example.com/icon.png', resolution: '32x32' }),
                    candidateJson(5, { img_src: 'https://cdn.example.com/file.pdf' }),
                    candidateJson(6, { resolution: '1080x1080', img_format: 'PNG' }),
                ],
            };
            globalThis.fetch = (async () =>
                new Response(JSON.stringify(payload), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                })) as typeof fetch;
            try {
                const outcome = await searchService.searchImages({
                    query: '狗头',
                    baseUrl: 'http://searxng:8080',
                    count: 8,
                    safesearch: 1,
                    engines: '',
                });
                expect(outcome.ok, `the stub answers (got ${JSON.stringify(outcome)})`);
                if (!outcome.ok) return;
                expect(
                    outcome.images.length === 2,
                    `pdf and icon are dropped, both gif spellings fold into one (got ${outcome.images.length})`
                );
                expect(outcome.images[0]?.originalSendable === false, 'a gif original can only be sent as its thumbnail');
                expect(outcome.images[0]?.thumbnailUrl.includes('thumb-1'), 'its thumbnail is kept');
                expect(outcome.images[1]?.width === 1080 && outcome.images[1]?.height === 1080, 'size comes from resolution');
                expect(outcome.images.at(-1)?.format === 'png', 'img_format is lowercased');
            } finally {
                globalThis.fetch = originalFetch;
            }
        },
    },
    {
        name: 'model images are replayed in each platform’s own shape',
        body: async (): Promise<void> => {
            const gemini = await import('../../src/ai/platforms/gemini/gemini-round-contents.js');
            const anthropic = await import('../../src/ai/platforms/anthropic/anthropic-tool-round.js');
            const openai = await import('../../src/ai/platforms/openai/responses-tool-round.js');
            const chat = await import('../../src/ai/platforms/chat-completions/chat-completions-tool-round.js');
            const grok = await import('../../src/ai/platforms/grok/grok-request.js');

            const executed = executedWithModelImage();
            const call = executed.call;

            const geminiPart = gemini.buildFunctionResponseParts([call], [executed.result])[0];
            const geminiResponse = geminiPart?.functionResponse;
            expect(
                geminiResponse?.parts?.length === 1 && geminiResponse.response?.output === executed.result.content,
                'Gemini: the image rides functionResponse.parts, the text stays in response.output'
            );

            const claudeBlocks = anthropic.toToolResultBlocks([executed]);
            const claudeContent = claudeBlocks[0]?.content;
            expect(
                Array.isArray(claudeContent) && claudeContent.length === 2 && claudeContent[1]?.type === 'image',
                'Claude: tool_result carries a text block and an image block'
            );

            const openaiMessages = openai.buildToolRoundMessages('好的', [executed]);
            const openaiImages = openaiMessages.filter((message) => message.role === 'user');
            expect(
                openaiImages.length === 1 &&
                    Array.isArray(openaiImages[0]?.content) &&
                    JSON.stringify(openaiImages[0]?.content).includes('input_image'),
                'OpenAI/ephone: a user message after the results carries input_image'
            );

            const chatTurn = chat.buildChatToolTurn({ text: '好的', reasoning: '' }, [executed], {
                supportsImageInput: true,
            });
            expect(
                chatTurn.at(-1)?.role === 'user' && JSON.stringify(chatTurn.at(-1)).includes('image_url'),
                'chat.completions: a user message with image_url'
            );
            const chatTurnBlind = chat.buildChatToolTurn({ text: '好的', reasoning: '' }, [executed], {
                supportsImageInput: false,
            });
            expect(chatTurnBlind.every((message) => message.role !== 'user'), 'a blind model gets no image message');

            const grokInput = grok.buildModelImagesInput([executed]);
            expect(grokInput.length === 1, 'Grok: one input item for the images');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
