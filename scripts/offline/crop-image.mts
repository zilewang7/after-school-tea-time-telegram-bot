/**
 * Offline cases for crop_image: the region/bbox argument shapes, the sidecar
 * outcomes that carry source dimensions, imgN registration, the per-reply cap
 * and the paths that must not touch the converter.
 *
 * Run: npx tsx scripts/offline/crop-image.mts
 *
 * No database, no network: the converter and every image loader are injected.
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);
const CROPPED = Buffer.concat([PNG, Buffer.from('cropped')]);

const { createReplyMediaState } = await import('../../src/reply/tools/reply-media-state.js');
const { createCropImageTool, MAX_CROPS_PER_REPLY } = await import('../../src/reply/tools/crop-image-tool.js');
const { resolveMediaRef } = await import('../../src/reply/tools/media-ref-resolver.js');

import type { ContextIndexEntry } from '../../src/reply/context-index.js';
import type { CropImageInput, CropImageOutcome, CropImageSuccess } from '../../src/services/tgs-client.js';

const CHAT_ID = -100999;
const MESSAGE_ID = 4242;

const imageEntry = (
    number: number,
    options: { count?: number; cloud?: boolean; messageId?: number } = {}
): ContextIndexEntry => {
    const count = options.count ?? 1;
    const images = Array.from({ length: count }, () => ({
        origin: 'attachment' as const,
        part: options.cloud === true
            ? { type: 'media' as const, fileUri: 'gs://bucket/photo.jpg', mimeType: 'image/jpeg' }
            : {
                  type: 'image' as const,
                  imageData: PNG.toString('base64'),
                  mimeType: 'image/png',
              },
    }));
    return {
        number,
        messageId: options.messageId ?? MESSAGE_ID,
        fromBot: false,
        images,
        imageCount: images.length,
    };
};

const contextOf = (entries: readonly ContextIndexEntry[]) => ({
    chatId: CHAT_ID,
    signal: AbortSignal.abort(),
    contextIndex: new Map(entries.map((entry) => [entry.number, entry])),
});

const noopLoader = async () => [];

const mediaRefsStub = {
    fetchImage: async () => ({
        ok: true as const,
        image: { data: PNG, mimeType: 'image/png' as const, finalUrl: 'https://example.com/a.png' },
    }),
    loadMessageImages: noopLoader,
};

const cropSuccess = (overrides: Partial<CropImageSuccess> = {}): CropImageSuccess => ({
    ok: true,
    data: CROPPED,
    mimeType: 'image/png',
    sourceWidth: 3024,
    sourceHeight: 4032,
    box: { x1: 100, y1: 200, x2: 900, y2: 800 },
    outputWidth: 800,
    outputHeight: 1200,
    flags: [],
    ...overrides,
});

interface CropStub {
    readonly calls: CropImageInput[];
    readonly crop: (input: CropImageInput) => Promise<CropImageOutcome>;
}

const cropStub = (outcome: (input: CropImageInput) => CropImageOutcome): CropStub => {
    const calls: CropImageInput[] = [];
    return {
        calls,
        crop: async (input) => {
            calls.push(input);
            return outcome(input);
        },
    };
};

const toolWith = (
    state: ReturnType<typeof createReplyMediaState>,
    entries: readonly ContextIndexEntry[],
    stub: CropStub
) =>
    createCropImageTool({
        state,
        context: contextOf(entries),
        dependencies: {
            crop: stub.crop,
            loadMessageImages: noopLoader,
            mediaRefs: mediaRefsStub,
        },
    });

const cases: CaseResult[] = [];

cases.push(
    await runCase('region and bbox are exclusive; a call with neither is refused', async () => {
        const state = createReplyMediaState();
        const stub = cropStub(() => cropSuccess());
        const tool = toolWith(state, [imageEntry(3)], stub);

        const both = await tool.execute({ source: '#3', region: 'center', bbox: { x1: 10, y1: 10, x2: 20, y2: 20 } }, AbortSignal.abort());
        expect(both.isError && both.content.includes('region 与 bbox'), `both shapes refused (got ${both.content.slice(0, 80)})`);
        const neither = await tool.execute({ source: '#3' }, AbortSignal.abort());
        expect(neither.isError && neither.content.includes('region 与 bbox'), 'a missing shape is refused');
        expect(stub.calls.length === 0, 'the converter was never called');
    })
);

cases.push(
    await runCase('region cells become the matching norm1000 box', async () => {
        const state = createReplyMediaState();
        const stub = cropStub(() => cropSuccess());
        const tool = toolWith(state, [imageEntry(3)], stub);

        const result = await tool.execute({ source: '#3', region: 'bottom-right' }, AbortSignal.abort());
        expect(!result.isError, `the crop succeeds (got ${result.content})`);
        expect(stub.calls.length === 1, 'one converter call');
        const call = stub.calls[0];
        expect(
            call !== undefined && call.unit === 'norm1000' && call.x1 === 667 && call.y1 === 667 && call.x2 === 1000 && call.y2 === 1000,
            `bottom-right maps to 667,667,1000,1000 (got ${call === undefined ? 'none' : `${call.x1},${call.y1},${call.x2},${call.y2}`})`
        );
    })
);

cases.push(
    await runCase('a picture of #N is cropped, registered as img1 and handed to the model', async () => {
        const state = createReplyMediaState();
        const stub = cropStub(() => cropSuccess());
        const tool = toolWith(state, [imageEntry(3)], stub);

        const result = await tool.execute({ source: '#3', bbox: { x1: 100, y1: 200, x2: 900, y2: 800 } }, AbortSignal.abort());
        expect(!result.isError, `the crop succeeds (got ${result.content})`);
        expect(stub.calls[0]?.data.equals(PNG) === true, 'the bytes the context carried were sent to the converter');
        expect(result.images.length === 0, 'nothing is delivered to the chat');
        expect(result.modelImages?.length === 1 && result.modelImages[0]?.data.equals(CROPPED) === true, 'the model sees the crop');
        expect(result.content.includes("send_image(image_id='img1'"), 'the result says how to deliver it');
        expect(result.content.includes("find_image(mode='reverse', image_id='img1'"), 'and how to reverse-search it');
        const registered = state.fetched.get('img1');
        expect(registered !== undefined && registered.data.equals(CROPPED), 'img1 is registered for the reply');
        expect(registered?.title === '#3 裁剪', `the title names the source (got ${registered?.title})`);
    })
);

cases.push(
    await runCase('an already registered imgN can be cropped again', async () => {
        const state = createReplyMediaState();
        const firstStub = cropStub(() => cropSuccess());
        const tool = toolWith(state, [imageEntry(3)], firstStub);
        await tool.execute({ source: '#3', region: 'center' }, AbortSignal.abort());

        const secondStub = cropStub(() => cropSuccess({ data: Buffer.concat([CROPPED, Buffer.from('twice')]), outputWidth: 512, outputHeight: 512 }));
        const again = toolWith(state, [imageEntry(3)], secondStub);
        const result = await again.execute({ source: 'img1', region: 'top-left' }, AbortSignal.abort());
        expect(!result.isError, `recropping works (got ${result.content})`);
        expect(secondStub.calls[0]?.data.equals(CROPPED) === true, 'the second crop uses the first crop bytes');
        expect(result.content.includes('img2'), 'the new crop gets the next id');
    })
);

cases.push(
    await runCase('a generate_image result (gN) is a valid crop source', async () => {
        const state = createReplyMediaState();
        state.generated.set('g1', { id: 'g1', data: CROPPED, mimeType: 'image/png' });
        const stub = cropStub(() => cropSuccess());
        const tool = toolWith(state, [], stub);

        const result = await tool.execute({ source: 'g1', region: 'center' }, AbortSignal.abort());
        expect(!result.isError, `gN is accepted (got ${result.content})`);
        expect(stub.calls[0]?.data.equals(CROPPED) === true, 'the drawn picture is the input');
    })
);

cases.push(
    await runCase('a 422 with source dimensions becomes a self-correcting unit hint', async () => {
        const state = createReplyMediaState();
        const stub = cropStub(() => ({
            ok: false,
            reason: 'invalid-box',
            message: 'crop is too small',
            sourceWidth: 3024,
            sourceHeight: 4032,
        }));
        const tool = toolWith(state, [imageEntry(3)], stub);

        const result = await tool.execute(
            { source: '#3', bbox: { x1: 100, y1: 200, x2: 900, y2: 800 }, unit: 'px' },
            AbortSignal.abort()
        );
        expect(result.isError, 'the call fails');
        expect(result.content.includes('归一化') && result.content.includes('unit="norm1000"'), `the hint names the unit fix (got ${result.content})`);
        expect(result.content.includes('3024×4032'), 'and the source dimensions');
        expect(state.fetched.size === 0, 'nothing is registered');
    })
);

cases.push(
    await runCase('a cloud-only (>20MB) picture is refused without calling the converter', async () => {
        const state = createReplyMediaState();
        const stub = cropStub(() => cropSuccess());
        const tool = toolWith(state, [imageEntry(3, { cloud: true })], stub);

        const result = await tool.execute({ source: '#3', region: 'center' }, AbortSignal.abort());
        expect(result.isError && result.content.includes('20MB'), `the cloud picture is refused (got ${result.content})`);
        expect(stub.calls.length === 0, 'the converter was never called');
    })
);

cases.push(
    await runCase('the per-reply cap stops the fifth crop before it reaches the converter', async () => {
        const state = createReplyMediaState();
        const stub = cropStub(() => cropSuccess());
        const tool = toolWith(state, [imageEntry(3)], stub);

        for (let index = 0; index < MAX_CROPS_PER_REPLY; index += 1) {
            const result = await tool.execute({ source: '#3', region: 'center' }, AbortSignal.abort());
            expect(!result.isError, `crop ${index + 1} succeeds`);
        }
        const over = await tool.execute({ source: '#3', region: 'center' }, AbortSignal.abort());
        expect(over.isError && over.content.includes('到上限'), `the fifth is refused (got ${over.content})`);
        expect(stub.calls.length === MAX_CROPS_PER_REPLY, 'the converter saw only four calls');
        expect(state.fetched.size === MAX_CROPS_PER_REPLY, 'four imgN were registered');
    })
);

cases.push(
    await runCase('a source that does not resolve is refused with the usable refs', async () => {
        const state = createReplyMediaState();
        const stub = cropStub(() => cropSuccess());
        const tool = toolWith(state, [imageEntry(3)], stub);

        const missing = await tool.execute({ source: '#9', region: 'center' }, AbortSignal.abort());
        expect(missing.isError && missing.content.includes('#9 不在当前上下文'), `a missing #N is named (got ${missing.content})`);
        const url = await tool.execute({ source: 'https://example.com/a.png', region: 'center' }, AbortSignal.abort());
        expect(url.isError && url.content.includes('https'), 'a url is refused with the supported shapes');
        expect(stub.calls.length === 0, 'no converter call for an unresolved source');
    })
);

cases.push(
    await runCase('a failed converter call registers nothing', async () => {
        const state = createReplyMediaState();
        const stub = cropStub(() => ({ ok: false, reason: 'failed' }));
        const tool = toolWith(state, [imageEntry(3)], stub);

        const result = await tool.execute({ source: '#3', region: 'center' }, AbortSignal.abort());
        expect(result.isError && result.content.includes('重试'), `the failure is explained (got ${result.content})`);
        expect(state.fetched.size === 0, 'no imgN was spent');
    })
);

cases.push(
    await runCase('the registered crop is resolvable by the reply image tools', async () => {
        const state = createReplyMediaState();
        const stub = cropStub(() => cropSuccess());
        const tool = toolWith(state, [imageEntry(3)], stub);
        const result = await tool.execute({ source: '#3', region: 'center' }, AbortSignal.abort());
        expect(!result.isError, 'the crop succeeded');

        const resolved = await resolveMediaRef(
            { kind: 'id', id: 'img1' },
            {
                state,
                chatId: CHAT_ID,
                contextIndex: new Map(),
                dependencies: mediaRefsStub,
            }
        );
        expect(resolved.ok && resolved.data.equals(CROPPED), 'send_image/find_image resolve img1 to the crop bytes');
    })
);

reportResults(cases);
