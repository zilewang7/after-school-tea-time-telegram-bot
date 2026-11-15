/**
 * Offline cases for the multi-picture half of `send_image`: one reply may add
 * several pictures, each with its own caption, up to the reply's limits
 * (MAX_REPLY_IMAGES pictures, MAX_REPLY_IMAGE_TOTAL_BYTES together, one
 * picture MAX_REPLY_IMAGE_BYTES), while stickers, files and cards still keep
 * the reply to one attachment.
 *
 * Pictures are taken from the reply's tool state (`fetched` / `generated`), so
 * no download and no network is involved. Telegram is never called: the tool
 * only records what the reply should send.
 *
 * Run: npx tsx scripts/offline/tools-image-multi.mts
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

await setupOfflineDb();
const { createSendImageTool } = await import('../../src/reply/tools/send-image-tool.js');
const { createReplyMediaState } = await import('../../src/reply/tools/reply-media-state.js');
const { loadMessageImages } = await import('../../src/reply/commands/reference-images.js');
const { MAX_REPLY_IMAGES, MAX_REPLY_IMAGE_BYTES, MAX_REPLY_IMAGE_TOTAL_BYTES } = await import(
    '../../src/shared/reply-media.js'
);

const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);

const NO_CONTEXT: ContextIndex = new Map();

/** No picture in these cases downloads anything; a call here is a bug */
const noNetworkFetch: ImageFetch = async () => {
    throw new Error('unexpected download in a tools-image-multi case');
};

const dependencies = { fetchImage: noNetworkFetch, loadMessageImages };

const toolOf = (state: ReturnType<typeof createReplyMediaState>): ToolHandler =>
    createSendImageTool({
        state,
        context: {
            chatId: OFFLINE_CHAT_ID,
            contextIndex: NO_CONTEXT,
            signal: new AbortController().signal,
        },
        dependencies,
    });

const runTool = (tool: ToolHandler, args: Record<string, unknown>): Promise<ToolResult> =>
    tool.execute(args, new AbortController().signal);

const json = (value: unknown): string => JSON.stringify(value);

/** A reply state carrying one fetched picture per id */
const stateWithFetched = (ids: readonly string[]) => {
    const state = createReplyMediaState();
    for (const [index, id] of ids.entries()) {
        state.fetched.set(id, {
            id,
            data: Buffer.concat([PNG_BYTES, Buffer.from(id)]),
            mimeType: 'image/png',
            still: { data: PNG_BYTES, mimeType: 'image/png' },
            sourcePage: `https://example.test/${id}`,
            title: `图片 ${index + 1}`,
            imageUrl: `https://example.test/${id}.png`,
        });
    }
    return state;
};

const results: CaseResult[] = [];

results.push(
    await runCase('two send_image calls add two pictures, each with its own caption', async () => {
        const state = stateWithFetched(['img1', 'img2']);
        const tool = toolOf(state);

        const first = await runTool(tool, { image_id: 'img1', caption: '第一张' });
        expect(!first.isError && first.images.length === 1, `the first picture is accepted (got ${json(first.content)})`);
        expect(first.images[0]?.caption === '第一张', 'with its own caption');
        expect(first.content.includes('第 1/10 张'), `the result names the position (got ${json(first.content)})`);

        const second = await runTool(tool, { image_id: 'img2', caption: '第二张' });
        expect(!second.isError && second.images.length === 1, `the second picture is accepted (got ${json(second.content)})`);
        expect(second.images[0]?.caption === '第二张', 'with a caption of its own');
        expect(second.content.includes('第 2/10 张'), `the result counts the reply (got ${json(second.content)})`);

        expect(state.imageCount === 2, `the reply counts both (got ${state.imageCount})`);
        expect(
            state.imageBytes === stateWithFetched(['img1', 'img2']).fetched.get('img1')!.data.length +
                stateWithFetched(['img1', 'img2']).fetched.get('img2')!.data.length,
            `and both byte counts (got ${state.imageBytes})`
        );
        expect(state.hasReplyImage, 'the reply now has pictures');
    })
);

results.push(
    await runCase('a picture without a caption leaves its slot empty', async () => {
        const state = stateWithFetched(['img1', 'img2']);
        const tool = toolOf(state);
        await runTool(tool, { image_id: 'img1' });
        await runTool(tool, { image_id: 'img2', caption: '有图注' });
        expect(state.imageCount === 2, 'both pictures are in');
        // The caption list is the reply's: second picture has one, first does not
        expect(state.imageBytes > 0, 'bytes are counted');
    })
);

results.push(
    await runCase('the tenth picture is accepted and the eleventh is refused', async () => {
        const state = stateWithFetched(['img1']);
        const tool = toolOf(state);
        for (let index = 1; index <= MAX_REPLY_IMAGES; index += 1) {
            const sent = await runTool(tool, { image_id: 'img1' });
            expect(!sent.isError, `picture ${index} is accepted (got ${json(sent.content)})`);
        }
        const beyond = await runTool(tool, { image_id: 'img1' });
        expect(
            beyond.isError && beyond.content.includes(`最多 ${MAX_REPLY_IMAGES} 张`),
            `the eleventh is refused with the limit (got ${json(beyond.content)})`
        );
        expect(state.imageCount === MAX_REPLY_IMAGES, 'the reply stays at the limit');
    })
);

results.push(
    await runCase('the reply total-bytes ceiling refuses the next picture', async () => {
        const state = stateWithFetched(['img1']);
        const tool = toolOf(state);
        await runTool(tool, { image_id: 'img1' });
        // Pretend the earlier pictures used almost the whole allowance
        state.imageBytes = MAX_REPLY_IMAGE_TOTAL_BYTES - 1;
        const refused = await runTool(tool, { image_id: 'img1' });
        expect(
            refused.isError && refused.content.includes('总大小'),
            `refused for total size (got ${json(refused.content)})`
        );
        expect(state.imageCount === 1, 'the refused picture is not counted');
    })
);

results.push(
    await runCase('a picture over the single-picture ceiling is refused', async () => {
        const state = createReplyMediaState();
        const oversized = Buffer.concat([PNG_BYTES, Buffer.alloc(MAX_REPLY_IMAGE_BYTES)]);
        state.generated.set('g1', { id: 'g1', data: oversized, mimeType: 'image/png' });
        const tool = toolOf(state);
        const refused = await runTool(tool, { image_id: 'g1' });
        expect(
            refused.isError && refused.content.includes(`${MAX_REPLY_IMAGE_BYTES / 1024 / 1024}MB`),
            `refused for size (got ${json(refused.content)})`
        );
        expect(state.imageCount === 0, 'nothing is counted');
    })
);

results.push(
    await runCase('a sticker, file or card on the reply refuses pictures', async () => {
        for (const kind of ['sticker', 'file', 'widget'] as const) {
            const state = stateWithFetched(['img1']);
            if (kind === 'sticker') state.hasReplySticker = true;
            if (kind === 'file') state.hasReplyFile = true;
            if (kind === 'widget') state.hasReplyWidget = true;
            const refused = await runTool(toolOf(state), { image_id: 'img1' });
            expect(refused.isError, `${kind}: pictures are refused`);
        }
    })
);

results.push(
    await runCase('an unknown picture id still fails the call', async () => {
        const state = stateWithFetched(['img1']);
        const refused = await runTool(toolOf(state), { image_id: 'img9' });
        expect(refused.isError && refused.content.includes('没有图片 img9'), `unknown id fails (got ${json(refused.content)})`);
        expect(state.imageCount === 0, 'and adds nothing');
    })
);

reportResults(results);
