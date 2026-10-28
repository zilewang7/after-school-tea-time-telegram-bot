/**
 * Offline cases for the sticker tools: the pack-order catalog, the resolver
 * (index / actual picture name / preview id), the misleading-name guard, the
 * one-visual-attachment rule, the fetch preview, and the stream chunk.
 *
 * Run: npx tsx scripts/offline/sticker.mts
 *
 * No database, no network: the sticker-set service gets a fake Api whose
 * getFile points at a real temp webp, so the bytes are sniffed for real.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import {
    STICKER_CATALOG,
    STICKER_CATALOG_TEXT,
} from '../../src/services/sticker-catalog.js';
import type { StickerSetApi } from '../../src/services/sticker-set-service.js';
import { resolveStickerQuery } from '../../src/reply/tools/sticker-query.js';
import { createReplyMediaState, type ReplyMediaState } from '../../src/reply/tools/reply-media-state.js';
import { parseFetchImageArgs } from '../../src/reply/tools/media-tool-args.js';
import type { ResponseState, StickerDelivery, StreamChunk } from '../../src/ai/types.js';

// The platforms build their clients at import time; nothing here sends a request
for (const key of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GROK_API_KEY', 'MIMO_API_KEY']) {
    process.env[key] ||= 'offline-placeholder';
}
const {
    createFetchImageTool,
    createSendImageTool,
    createSendStickerTool,
} = await import('../../src/reply/tools/index.js');
const { processChunk } = await import('../../src/reply/response-handler.js');

const SET_NAME = 'ColorfulHachimi';
const tempDirectory = mkdtempSync(join(tmpdir(), 'k-on-sticker-'));
const webpPath = join(tempDirectory, 'sticker.webp');
// A valid-enough WebP header for sniffImageMime; the service never decodes it
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);
writeFileSync(webpPath, WEBP);

const fakeApi: StickerSetApi = {
    getStickerSet: async (name: string) => ({
        stickers: STICKER_CATALOG.map((entry) => ({
            file_id: `file-${entry.packIndex}`,
            file_unique_id: entry.fileUniqueId,
            thumbnail: { file_id: `thumb-${entry.packIndex}` },
        })),
    }),
    getFile: async () => ({ file_path: webpPath }),
};

const signal = new AbortController().signal;

const entryOf = (query: string, state: ReplyMediaState) => {
    const result = resolveStickerQuery(query, state);
    if (!result.ok) throw new Error(`expected ${query} to resolve: ${result.error}`);
    return result.entry;
};

const errorOf = (query: string, state: ReplyMediaState) => {
    const result = resolveStickerQuery(query, state);
    if (result.ok) throw new Error(`expected ${query} to fail, got ${result.entry.label}`);
    return result.error;
};

const emptyState = (): ResponseState => ({
    textBuffer: '',
    thinkingBuffer: '',
    fullText: '',
    fullThinking: '',
    thinkingTruncatedChars: 0,
    images: [],
    stickers: [],
    groundingData: [],
    isDone: false,
});

const cases: Promise<CaseResult>[] = [];

cases.push(
    runCase('the catalog is the pack order: 72 unique pictures, 03 replaced by the author', async () => {
        expect(STICKER_CATALOG.length === 72, '72 pack positions');
        expect(STICKER_CATALOG[0]?.packIndex === 1 && STICKER_CATALOG[0]?.label === '眯眼猫嘴', '01 is 眯眼猫嘴');
        expect(
            STICKER_CATALOG[2]?.label === '蜷手困惑' && STICKER_CATALOG[2]?.fileUniqueId === 'AgADEyMAAv5cCVc',
            '03 is the picture the author added on 2026-10-27'
        );
        expect(STICKER_CATALOG[71]?.label === '藏在云朵里', '72 stayed 藏在云朵里');
        expect(
            STICKER_CATALOG[54]?.label === '星星眼跪坐笑',
            '55 is the sparkling-eye kneel, not the question marks its old label claimed'
        );
        expect(
            STICKER_CATALOG.every((entry) => entry.duplicateOf === undefined),
            'no picture repeats another any more'
        );
        expect(
            new Set(STICKER_CATALOG.map((entry) => entry.fileUniqueId)).size === 72,
            '72 distinct file ids'
        );
        expect(STICKER_CATALOG.every((entry, index) => entry.packIndex === index + 1), 'indices are 01..72');
    })
);

cases.push(
    runCase('the model-facing catalog uses actual pictures, not misleading filenames', async () => {
        const misleading = ['戴皇冠斗篷', '戴黄色猫帽', '系蝴蝶结叼棒棒糖', '戴螃蟹帽', '天使光环翅膀', '恶魔角翅膀', '新年橘子顶头'];
        for (const name of misleading) {
            expect(!STICKER_CATALOG_TEXT.includes(name), `description omits ${name}`);
        }
        expect(STICKER_CATALOG_TEXT.startsWith('01眯眼猫嘴'), 'starts at 01');
        expect(!STICKER_CATALOG_TEXT.includes('（与'), 'no duplicate note');
    })
);

cases.push(
    runCase('the resolver accepts pack indices, actual names and preview ids', async () => {
        const state = createReplyMediaState();
        expect(entryOf('7', state).packIndex === 7, '7');
        expect(entryOf('07', state).packIndex === 7, '07');
        expect(entryOf('#7', state).packIndex === 7, '#7');
        expect(entryOf('07_吃冰棒.png', state).packIndex === 7, 'original-name prefix + extension');
        expect(entryOf('吃冰棒', state).packIndex === 7, 'actual name');
        expect(entryOf('笑眼跪坐', state).packIndex === 42, 'actual name 42');

        state.fetchedStickers.set('st1', 7);
        expect(entryOf('st1', state).packIndex === 7, 'preview id');
    })
);

cases.push(
    runCase('the resolver refuses misleading names and explains what the picture shows', async () => {
        const state = createReplyMediaState();
        const hat = errorOf('戴黄色猫帽', state);
        expect(hat.includes('42') && hat.includes('笑眼跪坐'), 'cat hat points at 42 笑眼跪坐');
        const crown = errorOf('64_戴皇冠斗篷', state);
        expect(crown.includes('17') && crown.includes('端坐露齿笑'), 'crown points at 17, not pack 64');
        expect(errorOf('戴蓝黑条纹帽', state).includes('没有收进'), 'missing 67 is called out');
        expect(errorOf('99', state).includes('01'), 'out-of-range index lists the range');
        expect(errorOf('st9', state).includes('没有预览'), 'unknown preview id');
        const ambiguous = errorOf('疑惑', state);
        expect(ambiguous.includes('54') && ambiguous.includes('64'), 'ambiguous name lists both');
    })
);

cases.push(
    runCase('send_sticker resolves a real file_id and claims the reply attachment', async () => {
        const state = createReplyMediaState();
        const tool = createSendStickerTool({ state, context: { api: fakeApi, signal }, setName: SET_NAME });
        const result = await tool.execute({ sticker: '07' }, signal);
        expect(result.isError === false, 'not an error');
        const sticker = result.stickers?.[0];
        expect(sticker?.packIndex === 7 && sticker.label === '吃冰棒', 'sticker 07');
        expect(sticker?.fileId === 'file-7', 'file_id from the pack');
        expect(state.hasReplySticker, 'one attachment claimed');
        expect(result.content.includes('已发出贴纸 07 吃冰棒'), 'result names the sticker');
        expect((result.modelImages ?? []).length === 1, 'model sees what it sent');
        expect(result.modelImages?.[0]?.mimeType === 'image/webp', 'preview is webp');

        const second = await tool.execute({ sticker: '08' }, signal);
        expect(second.isError && second.content.includes('视觉附件'), 'second sticker is refused');

        const imageState = createReplyMediaState();
        imageState.hasReplyImage = true;
        const imageTool = createSendStickerTool({ state: imageState, context: { api: fakeApi, signal }, setName: SET_NAME });
        const refused = await imageTool.execute({ sticker: '07' }, signal);
        expect(refused.isError && refused.content.includes('视觉附件'), 'image already claimed');

        const badState = createReplyMediaState();
        const badTool = createSendStickerTool({ state: badState, context: { api: fakeApi, signal }, setName: SET_NAME });
        const bad = await badTool.execute({ sticker: '戴黄色猫帽' }, signal);
        expect(bad.isError && bad.content.includes('笑眼跪坐'), 'misleading name refused');
    })
);

cases.push(
    runCase('fetch_image reads a sticker, registers st1 and re-reads without a second picture', async () => {
        const state = createReplyMediaState();
        const tool = createFetchImageTool({
            state,
            dependencies: { fetchImage: async () => { throw new Error('not used'); } },
            sticker: { setName: SET_NAME, api: fakeApi },
        });
        const first = await tool.execute({ sticker: '07', view: 'thumbnail' }, signal);
        expect(first.isError === false, 'read');
        expect(first.modelImages?.[0]?.mimeType === 'image/webp', 'webp preview');
        expect(state.fetchedStickers.get('st1') === 7, 'st1 registered');
        expect(first.content.includes("send_sticker(sticker='st1')"), 'next step named');

        const again = await tool.execute({ sticker: 'st1' }, signal);
        expect((again.modelImages ?? []).length === 0, 'no duplicate image');
        expect(again.content.includes('已经预览过 st1'), 're-read is free');

        const badState = createReplyMediaState();
        const badTool = createSendStickerTool({ state: badState, context: { api: fakeApi, signal }, setName: SET_NAME });
        const bad = await badTool.execute({ sticker: '戴黄色猫帽' }, signal);
        expect(bad.isError && bad.content.includes('笑眼跪坐'), 'misleading name refused');
    })
);

cases.push(
    runCase('fetch_image accepts exactly one source and send_image refuses a sticker id', async () => {
        const both = parseFetchImageArgs({ sticker: '07', url: 'https://example.com/a.png' });
        expect(both.ok === false && both.error.includes('只传一个'), 'two sources refused');

        const state = createReplyMediaState();
        const sendImage = createSendImageTool({
            state,
            context: { chatId: 1, contextIndex: new Map(), signal },
            dependencies: {
                fetchImage: async () => { throw new Error('not used'); },
                loadMessageImages: async () => [],
            },
        });
        state.hasReplySticker = true;
        const refused = await sendImage.execute({}, signal);
        expect(refused.isError && refused.content.includes('视觉附件'), 'send_image sees the sticker');
    })
);

cases.push(
    runCase('a sticker stream chunk keeps only the first sticker', async () => {
        const sticker = (packIndex: number): StickerDelivery => ({
            packIndex,
            label: '吃冰棒',
            emoji: '🍦',
            fileId: `file-${packIndex}`,
            fileUniqueId: `unique-${packIndex}`,
        });
        const chunk: StreamChunk = { type: 'sticker', sticker: sticker(7) };
        const first = processChunk(chunk, emptyState(), (text) => text);
        const second = processChunk({ type: 'sticker', sticker: sticker(8) }, first, (text) => text);
        expect(first.stickers.length === 1 && first.stickers[0]?.packIndex === 7, 'first kept');
        expect(second.stickers.length === 1 && second.stickers[0]?.packIndex === 7, 'second ignored');
    })
);

const results = await Promise.all(cases);
reportResults(results);
rmSync(tempDirectory, { recursive: true, force: true });
