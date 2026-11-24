/**
 * Offline cases for the batch form of `send_image`: several pictures of the
 * same source lane in one call (`search_ids`, `image_ids`, `urls`, `messages`).
 *
 * The batch adds each picture to the reply in request order and checks the
 * reply's limits per picture, so one unreadable or over-quota source does not
 * drop the rest. Pictures that the model has not seen yet come back as
 * model-only images; ones it read or drew are already in the conversation. The
 * single form keeps its text, replay and trace unchanged.
 *
 * Nothing downloads and nothing reaches Telegram: the resolver takes its
 * downloader and message-image loader by injection, and the tool only records
 * what the reply should send.
 *
 * Run: npx tsx scripts/offline/send-image-batch.mts
 */
import {
    OFFLINE_CHAT_ID,
    expect,
    reportResults,
    runCase,
    setupOfflineDb,
    type CaseResult,
} from './harness.mts';
import type { ToolHandler, ToolResult } from '../../src/ai/tools/tool-types.js';
import type { ImageFetch } from '../../src/reply/tools/image-source-download.js';
import type { ContextIndex } from '../../src/reply/context-index.js';
import type { SearchCandidate } from '../../src/reply/tools/reply-media-state.js';

await setupOfflineDb();
const { createSendImageTool } = await import('../../src/reply/tools/send-image-tool.js');
const { createReplyMediaState } = await import('../../src/reply/tools/reply-media-state.js');
const { loadMessageImages } = await import('../../src/reply/commands/reference-images.js');
const { MAX_REPLY_IMAGES, MAX_REPLY_IMAGE_BYTES, MAX_REPLY_IMAGE_TOTAL_BYTES } = await import(
    '../../src/shared/reply-media.js'
);

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);
const GIF = Buffer.from('GIF89a offline animated bytes');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

const NO_CONTEXT: ContextIndex = new Map();

const json = (value: unknown): string => JSON.stringify(value);

/** A downloader that must not be called: these pictures are already in the state */
const noNetworkFetch: ImageFetch = async () => {
    throw new Error('unexpected download in a send-image-batch case');
};

const pngFetch = (url: string) =>
    ({
        ok: true as const,
        image: { data: PNG, mimeType: 'image/png' as const, finalUrl: url },
    });

const toolOf = (
    state: ReturnType<typeof createReplyMediaState>,
    options: {
        readonly fetchImage?: ImageFetch;
        readonly contextIndex?: ContextIndex;
        readonly signal?: AbortSignal;
        readonly loadImages?: (chatId: number, messageId: number) => Promise<
            readonly { readonly data: string; readonly mimeType: string }[]
        >;
    } = {}
): ToolHandler =>
    createSendImageTool({
        state,
        context: {
            chatId: OFFLINE_CHAT_ID,
            contextIndex: options.contextIndex ?? NO_CONTEXT,
            signal: options.signal ?? new AbortController().signal,
        },
        dependencies: {
            fetchImage: options.fetchImage ?? (async (url) => pngFetch(url)),
            loadMessageImages: options.loadImages ?? loadMessageImages,
        },
    });

const runTool = (tool: ToolHandler, args: Record<string, unknown>): Promise<ToolResult> =>
    tool.execute(args, new AbortController().signal);

/** A candidate as find_image(web) would have registered it */
const candidateOf = (id: string, overrides: Partial<SearchCandidate> = {}): SearchCandidate => ({
    id,
    searchId: 'q1',
    title: `候选 ${id}`,
    sourcePage: `https://example.test/${id}`,
    domain: 'example.test',
    imageUrl: `https://cdn.example.test/${id}.png`,
    thumbnailUrl: `https://cdn.example.test/${id}-thumb.png`,
    sendKind: 'static',
    ...overrides,
});

const stateWithCandidates = (ids: readonly string[], overrides: Partial<SearchCandidate> = {}) => {
    const state = createReplyMediaState();
    for (const id of ids) state.candidates.set(id, candidateOf(id, overrides));
    return state;
};

/** A reply state carrying one fetched picture per id */
const stateWithFetched = (ids: readonly string[]) => {
    const state = createReplyMediaState();
    for (const [index, id] of ids.entries()) {
        state.fetched.set(id, {
            id,
            data: PNG,
            mimeType: 'image/png',
            still: { data: PNG, mimeType: 'image/png' },
            sourcePage: `https://example.test/${id}`,
            title: `图片 ${index + 1}`,
            imageUrl: `https://example.test/${id}.png`,
        });
    }
    return state;
};

/** The schema field of one property, walked as plain JSON so no cast is needed */
const propertyFieldOf = (tool: ToolHandler, property: string, field: string): unknown => {
    const { properties } = tool.definition.inputSchema;
    if (properties === null || typeof properties !== 'object') return undefined;
    const definition: unknown = Reflect.get(properties, property);
    if (definition === null || typeof definition !== 'object') return undefined;
    return Reflect.get(definition, field);
};

const results: CaseResult[] = [];

results.push(
    await runCase('search_ids adds every candidate in request order, each with its own replay', async () => {
        const state = stateWithCandidates(['s1', 's2', 's3']);
        const result = await runTool(toolOf(state), { search_ids: ['s1', 's2', 's3'] });

        expect(!result.isError, `all three are added (got ${json(result.content)})`);
        expect(result.images.length === 3, `three pictures join the reply (got ${result.images.length})`);
        expect(state.imageCount === 3 && state.imageBytes === PNG.length * 3, 'the reply counts all three');
        expect(state.hasReplyImage, 'the reply now has pictures');
        expect(
            result.modelImages?.length === 3 && result.modelImages.every((image) => image.data.equals(PNG)),
            `the unseen pictures come back to the model (got ${result.modelImages?.length ?? 0})`
        );
        expect(
            result.content.startsWith('已加入 3 张图（本次回复第 1–3 张，最多 10 张）：'),
            `the header names the reply range (got ${json(result.content)})`
        );
        expect(result.content.includes('- 候选 s1「候选 s1」'), 'each line names its candidate');
        expect(result.trace?.argument === 's1,s2,s3', `the trace names the sources (got ${json(result.trace)})`);
        expect(result.trace?.result === 's1 等 3 张', 'the trace result counts the added pictures');
        expect(result.record !== null, 'the candidates bring their source pages');
    })
);

results.push(
    await runCase('urls: one failed download keeps the others and names the url by host and path', async () => {
        const requested: string[] = [];
        const fetchImage: ImageFetch = async (url) => {
            requested.push(url);
            if (url.includes('broken')) return { ok: false, error: '下载失败（HTTP 500）' };
            return pngFetch(url);
        };
        const result = await runTool(toolOf(createReplyMediaState(), { fetchImage }), {
            urls: [
                'https://cdn.example.test/a.png?token=secret',
                'https://cdn.example.test/broken.png?token=secret',
                'https://cdn.example.test/c.png',
            ],
        });

        expect(!result.isError, `the two readable urls are added (got ${json(result.content)})`);
        expect(result.images.length === 2, `two pictures join the reply (got ${result.images.length})`);
        expect(result.modelImages?.length === 2, 'and both come back to the model');
        expect(
            result.content.includes('有 1 张没加入：') &&
                result.content.includes('cdn.example.test/broken.png：图片没取到'),
            `the failure points at the url (got ${json(result.content)})`
        );
        expect(!result.content.includes('token=secret'), 'the query string never reaches the result');
        expect(
            requested.includes('https://cdn.example.test/a.png?token=secret') &&
                requested.includes('https://cdn.example.test/c.png'),
            `the readable urls were fetched (got ${json(requested)})`
        );
    })
);

results.push(
    await runCase('image_ids sends only pictures already in the conversation, repeats once', async () => {
        const state = stateWithFetched(['img1', 'img2']);
        const result = await runTool(toolOf(state, { fetchImage: noNetworkFetch }), {
            image_ids: ['img1', 'img2', 'img1'],
        });

        expect(!result.isError, `both pictures are added (got ${json(result.content)})`);
        expect(result.images.length === 2, `a repeated id is sent once (got ${result.images.length})`);
        expect(state.imageCount === 2, 'the reply counts two');
        expect(
            !result.modelImages || result.modelImages.length === 0,
            'a picture the model already read does not come back'
        );
        expect(
            result.content.includes('重复的 1 项已跳过：img1。'),
            `the repeat is said in the result (got ${json(result.content)})`
        );
    })
);

results.push(
    await runCase('messages takes the first picture of each context message', async () => {
        const contextIndex: ContextIndex = new Map([
            [3, { number: 3, messageId: 300, fromBot: false, images: [], imageCount: 0 }],
            [5, { number: 5, messageId: 500, fromBot: false, images: [], imageCount: 0 }],
        ]);
        const loaded: number[] = [];
        const result = await runTool(
            toolOf(createReplyMediaState(), {
                fetchImage: noNetworkFetch,
                contextIndex,
                loadImages: async (_chatId, messageId) => {
                    loaded.push(messageId);
                    return [{ data: PNG.toString('base64'), mimeType: 'image/png' }];
                },
            }),
            { messages: [3, 5] }
        );

        expect(!result.isError, `both context pictures are added (got ${json(result.content)})`);
        expect(result.images.length === 2, `two pictures join the reply (got ${result.images.length})`);
        expect(loaded.join(',') === '300,500', `each message was read once (got ${loaded.join(',')})`);
        expect(
            !result.modelImages || result.modelImages.length === 0,
            'pictures the conversation already carries are not replayed'
        );
        expect(
            result.content.includes('- #3 的图') && result.content.includes('- #5 的图'),
            `the lines name the context numbers (got ${json(result.content)})`
        );
    })
);

results.push(
    await runCase('mixed forms, mixed lanes, empty arrays and oversized batches are argument errors', async () => {
        const state = stateWithCandidates(['s1', 's2']);
        const tool = toolOf(state, { fetchImage: noNetworkFetch });
        const cases: ReadonlyArray<{ readonly args: Record<string, unknown>; readonly said: string }> = [
            { args: { search_id: 's1', search_ids: ['s2'] }, said: 'search_id 和 search_ids 只能传一个' },
            {
                args: { search_ids: ['s1'], urls: ['https://cdn.example.test/a.png'] },
                said: '一次只能一种来源',
            },
            { args: { search_ids: ['s1'], message: 3 }, said: '必须传且只传一个' },
            { args: { search_ids: [] }, said: 'search_ids 是空的' },
            {
                args: { search_ids: ['s1', 's2', 's1', 's2', 's1', 's2', 's3'] },
                said: 'search_ids 最多 6 项',
            },
            { args: { messages: [3, 3.5] }, said: 'messages 第 2 项必须是从 1 开始的整数' },
            { args: { image_ids: ['nope'] }, said: 'image_ids 第 1 项不是编号' },
            { args: { urls: ['ftp://example.test/a.png'] }, said: 'urls 第 1 项不是 http(s) 图片直链' },
        ];
        for (const testCase of cases) {
            const result = await runTool(tool, testCase.args);
            expect(
                result.isError && result.content.includes('参数有误：') && result.content.includes(testCase.said),
                `${json(testCase.args)} is refused with 「${testCase.said}」 (got ${json(result.content)})`
            );
        }
        expect(state.imageCount === 0, 'a rejected call adds nothing to the reply');
    })
);

results.push(
    await runCase('a batch stops at the reply quota and names what is left', async () => {
        const state = stateWithCandidates(['s1', 's2', 's3']);
        state.imageCount = 9;
        state.hasReplyImage = true;
        const requested: string[] = [];
        const fetchImage: ImageFetch = async (url) => {
            requested.push(url);
            return pngFetch(url);
        };

        const result = await runTool(toolOf(state, { fetchImage }), { search_ids: ['s1', 's2', 's3'] });

        expect(!result.isError, 'the one picture that fits is added');
        expect(result.images.length === 1, `only one picture joins (got ${result.images.length})`);
        expect(state.imageCount === MAX_REPLY_IMAGES, 'the reply reaches its limit');
        expect(
            result.content.includes(`已加入 1 张图（本次回复第 ${MAX_REPLY_IMAGES} 张，最多 ${MAX_REPLY_IMAGES} 张）：`),
            `the header counts the reply position (got ${json(result.content)})`
        );
        expect(
            result.content.includes('有 2 张没加入：') && result.content.includes('额度只剩 0 张'),
            `the rest name the remaining quota (got ${json(result.content)})`
        );
        expect(requested.length === 1, `the over-quota pictures are not downloaded (got ${requested.length})`);
    })
);

results.push(
    await runCase('a sticker, file or card on the reply refuses the whole batch', async () => {
        for (const kind of ['sticker', 'file', 'widget'] as const) {
            const state = stateWithCandidates(['s1', 's2']);
            if (kind === 'sticker') state.hasReplySticker = true;
            if (kind === 'file') state.hasReplyFile = true;
            if (kind === 'widget') state.hasReplyWidget = true;
            const result = await runTool(toolOf(state, { fetchImage: noNetworkFetch }), {
                search_ids: ['s1', 's2'],
            });
            expect(
                result.isError && result.content.includes('不能同时发'),
                `${kind}: the batch is refused with the one-attachment rule (got ${json(result.content)})`
            );
            expect(state.imageCount === 0, `${kind}: nothing is added`);
        }
    })
);

results.push(
    await runCase('the caption goes on the first picture that actually joins the reply', async () => {
        const state = stateWithFetched(['img1', 'img2']);
        const allAdded = await runTool(toolOf(state), {
            image_ids: ['img1', 'img2'],
            caption: '两张对比',
        });
        expect(allAdded.images[0]?.caption === '两张对比', 'the first picture carries the caption');
        expect(allAdded.images[1]?.caption === undefined, 'the second one does not');

        const oneLeft = stateWithFetched(['img1']);
        const afterFailure = await runTool(toolOf(oneLeft), {
            image_ids: ['img9', 'img1'],
            caption: '只给这张',
        });
        expect(afterFailure.images.length === 1, `the readable picture is added (got ${json(afterFailure.content)})`);
        expect(
            afterFailure.images[0]?.caption === '只给这张',
            'the caption skips the failed source and lands on the first success'
        );
    })
);

results.push(
    await runCase('a batch whose pictures all fail is an error result', async () => {
        const state = stateWithFetched(['img1']);
        const result = await runTool(toolOf(state, { fetchImage: noNetworkFetch }), {
            image_ids: ['img8', 'img9'],
        });

        expect(result.isError, `the call fails (got ${json(result.content)})`);
        expect(
            result.content.startsWith('这 2 张图都没加入：'),
            `the header says nothing joined (got ${json(result.content)})`
        );
        expect(result.content.includes('没有图片 img8') && result.content.includes('没有图片 img9'), 'both are named');
        expect(
            (result.trace?.result ?? '').startsWith('这 2 张都没加入'),
            `the trace says it (got ${json(result.trace?.result)})`
        );
        expect(state.imageCount === 0, 'nothing joins the reply');
    })
);

results.push(
    await runCase('a stopped reply adds what it already resolved and names the rest', async () => {
        const state = stateWithCandidates(['s1', 's2', 's3']);
        const controller = new AbortController();
        let downloads = 0;
        const fetchImage: ImageFetch = async (url) => {
            downloads += 1;
            controller.abort();
            return pngFetch(url);
        };
        const result = await runTool(
            toolOf(state, { fetchImage, signal: controller.signal }),
            { search_ids: ['s1', 's2', 's3'] }
        );

        expect(result.images.length === 1, `the picture in flight is kept (got ${result.images.length})`);
        expect(!result.isError, 'the call still reports what joined');
        expect(
            result.content.includes('有 2 张没加入：') && result.content.includes('回复已停止，没有加入。'),
            `the rest say the reply stopped (got ${json(result.content)})`
        );
        expect(downloads === 1, `the rest is never downloaded (got ${downloads})`);
        expect(state.imageCount === 1, 'only the resolved picture joins the reply');
    })
);

results.push(
    await runCase('the schema declares the four plural lanes with the batch bounds', async () => {
        const tool = toolOf(createReplyMediaState());
        for (const name of ['search_ids', 'image_ids', 'urls'] as const) {
            expect(propertyFieldOf(tool, name, 'type') === 'array', `${name} is an array`);
            expect(propertyFieldOf(tool, name, 'minItems') === 1, `${name} needs at least one item`);
            expect(propertyFieldOf(tool, name, 'maxItems') === 6, `${name} is capped at six`);
        }
        expect(propertyFieldOf(tool, 'messages', 'type') === 'array', 'messages is an array');
        expect(propertyFieldOf(tool, 'messages', 'minItems') === 1, 'messages needs at least one item');
        expect(propertyFieldOf(tool, 'messages', 'maxItems') === 6, 'messages is capped at six');
        expect(
            tool.definition.description.includes('批量用同类复数数组') &&
                tool.definition.description.includes('≤6 张'),
            `the description teaches the batch form (got ${json(tool.definition.description)})`
        );
    })
);

results.push(
    await runCase('the single form keeps its exact text, replay and trace', async () => {
        const state = stateWithCandidates(['s1']);
        const result = await runTool(toolOf(state), { search_id: 's1' });

        expect(!result.isError, `the picture is added (got ${json(result.content)})`);
        expect(
            result.content ===
                '已把候选 s1的图片发到聊天里，会附在你这条回复后面。' +
                    '这是本条回复的第 1/10 张；还可以继续 send_image 加图（多张会作为一条相册发出）。' +
                    '\n来源页：https://example.test/s1',
            `the single result is byte-for-byte the old one (got ${json(result.content)})`
        );
        expect(result.trace?.argument === 's1', `the trace argument is the source (got ${json(result.trace)})`);
        expect(result.trace?.result === '第 1/10 张', `the trace result is the position (got ${json(result.trace)})`);
        expect(result.modelImages?.length === 1, 'an unseen picture still comes back to the model');
        expect(result.images.length === 1, 'one picture is delivered');
    })
);

results.push(
    await runCase('a GIF in a batch is delivered as an animation and replayed as its still', async () => {
        const state = stateWithCandidates(['s1'], {
            title: '动图候选',
            imageUrl: 'https://cdn.example.test/a.gif',
            thumbnailUrl: 'https://cdn.example.test/a-thumb.jpg',
            sendKind: 'animated',
        });
        const fetchImage: ImageFetch = async (url) =>
            url.endsWith('.gif')
                ? { ok: true, image: { data: GIF, mimeType: 'image/gif', finalUrl: url } }
                : { ok: true, image: { data: JPEG, mimeType: 'image/jpeg', finalUrl: url } };

        const result = await runTool(toolOf(state, { fetchImage }), { search_ids: ['s1'] });

        expect(!result.isError, `the animation goes out (got ${json(result.content)})`);
        expect(
            result.images[0]?.mimeType === 'image/gif' && result.images[0].data.equals(GIF),
            'the chat receives the GIF itself'
        );
        expect(
            result.modelImages?.[0]?.mimeType === 'image/jpeg' && result.modelImages[0].data.equals(JPEG),
            'the model is shown the still frame'
        );
        expect(result.content.includes('（动图）'), `the result marks the animation (got ${json(result.content)})`);
    })
);

results.push(
    await runCase('the per-picture and reply-wide byte ceilings fail items, not the call', async () => {
        const state = createReplyMediaState();
        const oversized = Buffer.concat([PNG, Buffer.alloc(MAX_REPLY_IMAGE_BYTES)]);
        state.generated.set('g1', { id: 'g1', data: oversized, mimeType: 'image/png' });
        state.fetched.set('img1', {
            id: 'img1',
            data: PNG,
            mimeType: 'image/png',
            still: { data: PNG, mimeType: 'image/png' },
            sourcePage: '',
            imageUrl: 'https://cdn.example.test/img1.png',
        });
        const result = await runTool(toolOf(state, { fetchImage: noNetworkFetch }), {
            image_ids: ['g1', 'img1'],
        });

        expect(!result.isError, `the fitting picture is still added (got ${json(result.content)})`);
        expect(result.images.length === 1, `one picture joins (got ${result.images.length})`);
        expect(
            result.content.includes(`${MAX_REPLY_IMAGE_BYTES / 1024 / 1024}MB`),
            `the oversized one is named (got ${json(result.content)})`
        );

        const full = stateWithFetched(['img1']);
        full.imageBytes = MAX_REPLY_IMAGE_TOTAL_BYTES;
        const refused = await runTool(toolOf(full, { fetchImage: noNetworkFetch }), {
            image_ids: ['img1'],
        });
        expect(refused.isError && refused.content.includes('总大小'), `the reply budget is enforced (got ${json(refused.content)})`);
    })
);

results.push(
    await runCase('blank and zero single-form fields are fillers for a batch call', async () => {
        const state = stateWithCandidates(['s1', 's2']);
        const result = await runTool(toolOf(state), {
            search_ids: ['s1', 's2'],
            search_id: '',
            image_id: null,
            url: '',
            message: 0,
            image: 0,
            caption: '',
        });

        expect(!result.isError, `fillers do not fail the batch (got ${json(result.content)})`);
        expect(result.images.length === 2, `both pictures join the reply (got ${result.images.length})`);
        expect(state.imageCount === 2, 'the reply counts both');
    })
);

reportResults(results);
