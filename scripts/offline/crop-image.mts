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
    await runCase('0-coordinate edge boxes and full-frame boundaries succeed in norm1000 and px', async () => {
        for (const scenario of [
            {
                name: 'issue #18 default norm1000 x1=0',
                args: { source: '#3', bbox: { x1: 0, y1: 102, x2: 1000, y2: 920 } },
                expectedUnit: 'norm1000' as const,
                expectedBox: { x1: 0, y1: 87, x2: 1280, y2: 786 },
            },
            {
                name: 'issue #18 explicit norm1000 x1=0',
                args: { source: '#3', unit: 'norm1000', bbox: { x1: 0, y1: 102, x2: 1000, y2: 920 } },
                expectedUnit: 'norm1000' as const,
                expectedBox: { x1: 0, y1: 87, x2: 1280, y2: 786 },
            },
            {
                name: 'issue #18 px x1=0',
                args: { source: '#3', unit: 'px', bbox: { x1: 0, y1: 88, x2: 1280, y2: 786 } },
                expectedUnit: 'px' as const,
                expectedBox: { x1: 0, y1: 88, x2: 1280, y2: 786 },
            },
            {
                name: 'y1=0 top-edge norm1000',
                args: { source: '#3', unit: 'norm1000', bbox: { x1: 100, y1: 0, x2: 900, y2: 500 } },
                expectedUnit: 'norm1000' as const,
                expectedBox: { x1: 128, y1: 0, x2: 1152, y2: 427 },
            },
            {
                name: 'full-frame norm1000 (0,0,1000,1000)',
                args: { source: '#3', unit: 'norm1000', bbox: { x1: 0, y1: 0, x2: 1000, y2: 1000 } },
                expectedUnit: 'norm1000' as const,
                expectedBox: { x1: 0, y1: 0, x2: 1280, y2: 854 },
            },
            {
                name: 'full-frame px (0,0,1280,854)',
                args: { source: '#3', unit: 'px', bbox: { x1: 0, y1: 0, x2: 1280, y2: 854 } },
                expectedUnit: 'px' as const,
                expectedBox: { x1: 0, y1: 0, x2: 1280, y2: 854 },
            },
        ]) {
            const state = createReplyMediaState();
            const stub = cropStub(() =>
                cropSuccess({
                    sourceWidth: 1280,
                    sourceHeight: 854,
                    box: scenario.expectedBox,
                    outputWidth: scenario.expectedBox.x2 - scenario.expectedBox.x1,
                    outputHeight: scenario.expectedBox.y2 - scenario.expectedBox.y1,
                })
            );
            const tool = toolWith(state, [imageEntry(3)], stub);
            const result = await tool.execute(scenario.args, AbortSignal.abort());
            expect(!result.isError, `${scenario.name}: succeeds (got ${result.content})`);
            const call = stub.calls[0];
            expect(
                call !== undefined
                    && call.unit === scenario.expectedUnit
                    && call.x1 === scenario.args.bbox.x1
                    && call.y1 === scenario.args.bbox.y1
                    && call.x2 === scenario.args.bbox.x2
                    && call.y2 === scenario.args.bbox.y2,
                `${scenario.name}: forwards exact box and unit`
            );
            expect(
                result.content.includes(
                    `[x ${scenario.expectedBox.x1}-${scenario.expectedBox.x2}, y ${scenario.expectedBox.y1}-${scenario.expectedBox.y2}]`
                ),
                `${scenario.name}: reports exact crop coordinates`
            );
        }
    })
);

cases.push(
    await runCase('invalid or out-of-range norm1000 bbox coordinates are rejected locally', async () => {
        const state = createReplyMediaState();
        const stub = cropStub(() => cropSuccess());
        const tool = toolWith(state, [imageEntry(3)], stub);

        const negative = await tool.execute(
            { source: '#3', unit: 'norm1000', bbox: { x1: -1, y1: 0, x2: 500, y2: 500 } },
            AbortSignal.abort()
        );
        expect(negative.isError && negative.content.includes('0-1000'), 'negative norm1000 rejected locally');

        const over = await tool.execute(
            { source: '#3', unit: 'norm1000', bbox: { x1: 0, y1: 0, x2: 1001, y2: 500 } },
            AbortSignal.abort()
        );
        expect(over.isError && over.content.includes('0-1000'), 'over-1000 norm1000 rejected locally');

        const missingField = await tool.execute(
            { source: '#3', bbox: { x1: 0, y1: 0, x2: 500 } },
            AbortSignal.abort()
        );
        expect(missingField.isError && missingField.content.includes('bbox.y2'), 'missing bbox field is named');
        expect(stub.calls.length === 0, 'invalid coordinates never hit the converter');
    })
);

cases.push(
    await runCase('a negative px invalid-box does not trigger the norm1000 misuse hint', async () => {
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
            { source: '#3', bbox: { x1: -50, y1: 0, x2: 20, y2: 100 }, unit: 'px' },
            AbortSignal.abort()
        );
        expect(result.isError, 'fails cleanly');
        expect(!result.content.includes('归一化'), 'negative px does not claim norm1000');
        expect(result.content.includes('3024×4032'), 'includes source dimensions');
    })
);

cases.push(
    await runCase('real timeouts vs non-timeout failures produce distinct guidance and register nothing', async () => {
        const state = createReplyMediaState();

        const timeoutTool = toolWith(state, [imageEntry(3)], cropStub(() => ({ ok: false, reason: 'timeout' })));
        const timeoutResult = await timeoutTool.execute({ source: '#3', region: 'center' }, AbortSignal.abort());
        expect(
            timeoutResult.isError && timeoutResult.content.includes('超时') && timeoutResult.content.includes('重试'),
            `real timeout suggests retry (got ${timeoutResult.content})`
        );

        const failedTool = toolWith(
            state,
            [imageEntry(3)],
            cropStub(() => ({ ok: false, reason: 'failed', message: 'unusable metadata' }))
        );
        const failedResult = await failedTool.execute({ source: '#3', region: 'center' }, AbortSignal.abort());
        expect(
            failedResult.isError
                && !failedResult.content.includes('超时')
                && !failedResult.content.includes('可以重试一次')
                && failedResult.content.includes('unusable metadata'),
            `non-timeout failure must not masquerade as timeout (got ${failedResult.content})`
        );

        const badArgsTool = toolWith(
            state,
            [imageEntry(3)],
            cropStub(() => ({ ok: false, reason: 'invalid-args', message: 'scale must be within 1-4' }))
        );
        const badArgsResult = await badArgsTool.execute({ source: '#3', region: 'center' }, AbortSignal.abort());
        expect(
            badArgsResult.isError
                && !badArgsResult.content.includes('超时')
                && badArgsResult.content.includes('参数无效'),
            `invalid-args surfaces parameter error without timeout (got ${badArgsResult.content})`
        );

        expect(state.fetched.size === 0, 'no imgN was spent on any failure');
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
