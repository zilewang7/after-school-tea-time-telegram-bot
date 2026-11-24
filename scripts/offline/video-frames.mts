/**
 * Offline cases for extract_frames: argument combinations, the inline and the
 * signed-GCS source paths, imgN registration, the reply-wide frame cap and the
 * failures that must not touch the converter.
 *
 * Run: npx tsx scripts/offline/video-frames.mts
 *
 * No database, no network: the message row, media cache, signer and converter
 * are injected.
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('offline frame')]);
const MP4 = Buffer.from('offline video bytes');

const { createReplyMediaState } = await import('../../src/reply/tools/reply-media-state.js');
const { createExtractFramesTool, MAX_FRAMES_PER_REPLY } = await import('../../src/reply/tools/video-frames-tool.js');
const { resolveMediaRef } = await import('../../src/reply/tools/media-ref-resolver.js');

import type { ContextIndexEntry } from '../../src/reply/context-index.js';
import type {
    ExtractFramesDependencies,
    FrameCachedMedia,
} from '../../src/reply/tools/video-frames-tool.js';
import type {
    ExtractVideoFramesInput,
    ExtractVideoFramesOutcome,
    ExtractedVideoFrame,
} from '../../src/services/tgs-client.js';

const CHAT_ID = -100999;
const MESSAGE_ID = 777;

const entryOf = (number: number): ContextIndexEntry => ({
    number,
    messageId: MESSAGE_ID,
    fromBot: false,
    images: [],
    imageCount: 0,
});

const contextOf = (entries: readonly ContextIndexEntry[]) => ({
    chatId: CHAT_ID,
    signal: AbortSignal.abort(),
    contextIndex: new Map(entries.map((entry) => [entry.number, entry])),
});

const videoMedia = (overrides: Partial<FrameCachedMedia> = {}): FrameCachedMedia => ({
    mime: 'video/mp4',
    kind: 'video',
    data: MP4,
    fileUri: null,
    sizeBytes: MP4.length,
    durationSeconds: 12,
    ...overrides,
});

const frameOf = (time: number, data: Buffer = PNG): ExtractedVideoFrame => ({
    requestedT: time,
    actualT: time,
    mimeType: 'image/jpeg',
    width: 960,
    height: 540,
    data,
});

const framesSuccess = (
    frames: readonly ExtractedVideoFrame[],
    overrides: Partial<ExtractVideoFramesOutcome & { ok: true }> = {}
): ExtractVideoFramesOutcome => ({
    ok: true,
    duration: 12.3,
    width: 720,
    height: 1280,
    fps: 30,
    rotation: 0,
    frames,
    notes: [],
    ...overrides,
});

interface FramesStub {
    readonly calls: ExtractVideoFramesInput[];
    readonly extractFrames: (input: ExtractVideoFramesInput) => Promise<ExtractVideoFramesOutcome>;
}

const framesStub = (
    outcome: (input: ExtractVideoFramesInput) => ExtractVideoFramesOutcome
): FramesStub => {
    const calls: ExtractVideoFramesInput[] = [];
    return {
        calls,
        extractFrames: async (input) => {
            calls.push(input);
            return outcome(input);
        },
    };
};

interface DependencyState {
    readonly signCalls: Array<{ gsUri: string; ttlSeconds: number }>;
    readonly deps: ExtractFramesDependencies;
}

const dependenciesWith = (
    stub: FramesStub,
    options: {
        media?: FrameCachedMedia;
        signedUrl?: string | null;
        row?: { fileUniqueId: string | null } | null;
    } = {}
): DependencyState => {
    const signCalls: Array<{ gsUri: string; ttlSeconds: number }> = [];
    const media = options.media === undefined ? videoMedia() : options.media;
    return {
        signCalls,
        deps: {
            getMessage: async () => (options.row === undefined ? { fileUniqueId: 'uid-1' } : options.row),
            getCachedMedia: async () => media,
            signReadUrl: async (gsUri, ttlSeconds) => {
                signCalls.push({ gsUri, ttlSeconds });
                return options.signedUrl === undefined ? 'https://storage.googleapis.com/b/obj?X-Sig=1' : options.signedUrl;
            },
            extractFrames: stub.extractFrames,
        },
    };
};

const toolWith = (
    state: ReturnType<typeof createReplyMediaState>,
    number: number,
    deps: ExtractFramesDependencies
) =>
    createExtractFramesTool({
        state,
        context: contextOf([entryOf(number)]),
        dependencies: deps,
    });

const cases: CaseResult[] = [];

cases.push(
    await runCase('conflicting or malformed frame arguments are refused before the converter', async () => {
        const state = createReplyMediaState();
        const stub = framesStub(() => framesSuccess([frameOf(1)]));
        const deps = dependenciesWith(stub).deps;
        const tool = toolWith(state, 12, deps);

        const both = await tool.execute({ message: 12, times: [1], count: 2 }, AbortSignal.abort());
        expect(both.isError && both.content.includes('times 与 count'), `times+count refused (got ${both.content.slice(0, 80)})`);
        const modeWithout = await tool.execute({ message: 12, mode: 'times' }, AbortSignal.abort());
        expect(modeWithout.isError && modeWithout.content.includes('mode'), 'mode=times without times is refused');
        const empty = await tool.execute({ message: 12, times: [], count: 0 }, AbortSignal.abort());
        expect(empty.isError, 'an unusable count is refused');
        const badSize = await tool.execute({ message: 12, size: 100 }, AbortSignal.abort());
        expect(badSize.isError && badSize.content.includes('size'), 'an unsupported size is refused');
        const badRange = await tool.execute({ message: 12, start: 5, end: 5 }, AbortSignal.abort());
        expect(badRange.isError && badRange.content.includes('end 必须大于 start'), 'an empty range is refused');
        const noMessage = await tool.execute({ times: [1] }, AbortSignal.abort());
        expect(noMessage.isError && noMessage.content.includes('message'), 'a missing message is refused');
        expect(stub.calls.length === 0, 'the converter was never called');
    })
);

cases.push(
    await runCase('an inline video yields stills registered as imgN, one per frame', async () => {
        const state = createReplyMediaState();
        const stub = framesStub(() => framesSuccess([frameOf(0), frameOf(6.15), frameOf(12.3)]));
        const deps = dependenciesWith(stub);
        const tool = toolWith(state, 12, deps.deps);

        const result = await tool.execute({ message: 12, count: 3 }, AbortSignal.abort());
        expect(!result.isError, `the extraction succeeds (got ${result.content})`);
        expect(stub.calls.length === 1, 'one converter call');
        const call = stub.calls[0];
        expect(call?.mode === 'uniform' && call.count === 3, 'uniform sampling with the asked count');
        expect(call?.source.kind === 'bytes' && call.source.data.equals(MP4), 'the cached bytes go to the converter');
        expect(result.images.length === 0, 'nothing is delivered');
        expect(result.modelImages?.length === 3, `three frames are replayed (got ${result.modelImages?.length ?? 0})`);
        expect(result.content.includes('12.3s') && result.content.includes('720×1280'), 'the duration and size are stated');
        const ids = ['img1', 'img2', 'img3'];
        expect(ids.every((id) => state.fetched.has(id)), 'all three ids are registered');
        expect(state.fetched.get('img2')?.data.equals(PNG), 'the frame bytes are the registered ones');
        expect(result.content.includes("send_image(image_id='img1'"), 'the delivery hint names the first frame');
        expect(result.content.includes('还剩 3 帧'), `the remaining frame budget is stated (got ${result.content})`);
    })
);

cases.push(
    await runCase('exact times are passed through in order', async () => {
        const state = createReplyMediaState();
        const stub = framesStub(() => framesSuccess([frameOf(3.5, JPEG), frameOf(12)]));
        const deps = dependenciesWith(stub);
        const tool = toolWith(state, 12, deps.deps);

        const result = await tool.execute({ message: 12, times: [3.5, 12] }, AbortSignal.abort());
        expect(!result.isError, `the extraction succeeds (got ${result.content})`);
        const call = stub.calls[0];
        expect(
            call?.mode === 'times' && call.times?.join(',') === '3.5,12',
            `the requested times reach the converter (got ${call?.times?.join(',') ?? 'none'})`
        );
        expect(result.content.indexOf('3.5s') < result.content.indexOf('12.0s'), 'the listing keeps the requested order');
    })
);

cases.push(
    await runCase('first/last modes ask only for one still', async () => {
        const state = createReplyMediaState();
        const stub = framesStub(() => framesSuccess([frameOf(12.15)]));
        const deps = dependenciesWith(stub);
        const tool = toolWith(state, 12, deps.deps);

        const result = await tool.execute({ message: 12, mode: 'last' }, AbortSignal.abort());
        expect(!result.isError, `the extraction succeeds (got ${result.content})`);
        expect(stub.calls[0]?.mode === 'last', 'the converter is asked for the last frame');
        expect(state.fetched.size === 1, 'one imgN was registered');
    })
);

cases.push(
    await runCase('a >20MB GCS video is signed and read by the converter remotely', async () => {
        const state = createReplyMediaState();
        const stub = framesStub(() => framesSuccess([frameOf(6.15)]));
        const deps = dependenciesWith(stub, {
            media: videoMedia({
                data: null,
                fileUri: 'gs://bucket/large.mp4',
                sizeBytes: 200 * 1024 * 1024,
                durationSeconds: 600,
            }),
        });
        const tool = toolWith(state, 12, deps.deps);

        const result = await tool.execute({ message: 12, count: 1 }, AbortSignal.abort());
        expect(!result.isError, `the remote extraction succeeds (got ${result.content})`);
        expect(deps.signCalls.length === 1 && deps.signCalls[0]?.gsUri === 'gs://bucket/large.mp4', 'the GCS object was signed');
        expect(deps.signCalls[0]?.ttlSeconds === 300, 'the URL lives long enough for one read');
        const call = stub.calls[0];
        expect(
            call?.source.kind === 'url' && call.source.url.startsWith('https://storage.googleapis.com/'),
            'the converter receives the signed URL, not the bytes'
        );
        expect(call?.source.kind === 'url' && call.source.sourceBytes === 200 * 1024 * 1024, 'the source size rides along');
        expect(state.fetched.size === 1, 'the still is registered');
    })
);

cases.push(
    await runCase('a >300MB video is refused before signing', async () => {
        const state = createReplyMediaState();
        const stub = framesStub(() => framesSuccess([frameOf(1)]));
        const deps = dependenciesWith(stub, {
            media: videoMedia({ data: null, fileUri: 'gs://bucket/huge.mp4', sizeBytes: 320 * 1024 * 1024 }),
        });
        const tool = toolWith(state, 12, deps.deps);

        const result = await tool.execute({ message: 12, count: 1 }, AbortSignal.abort());
        expect(result.isError && result.content.includes('300MB'), `the size limit is explained (got ${result.content})`);
        expect(deps.signCalls.length === 0, 'nothing was signed');
        expect(stub.calls.length === 0, 'the converter was never called');
    })
);

cases.push(
    await runCase('a failed signature is a readable failure', async () => {
        const state = createReplyMediaState();
        const stub = framesStub(() => framesSuccess([frameOf(1)]));
        const deps = dependenciesWith(stub, {
            media: videoMedia({ data: null, fileUri: 'gs://bucket/large.mp4', sizeBytes: 40 * 1024 * 1024 }),
            signedUrl: null,
        });
        const tool = toolWith(state, 12, deps.deps);

        const result = await tool.execute({ message: 12, count: 1 }, AbortSignal.abort());
        expect(result.isError && result.content.includes('签名'), `the signing failure is explained (got ${result.content})`);
        expect(stub.calls.length === 0, 'the converter was never called');
        expect(state.fetched.size === 0, 'nothing was registered');
    })
);

cases.push(
    await runCase('expired media and non-dynamic messages are refused', async () => {
        const state = createReplyMediaState();
        const stub = framesStub(() => framesSuccess([frameOf(1)]));
        const expired = dependenciesWith(stub);
        const expiredTool = createExtractFramesTool({
            state,
            context: contextOf([entryOf(12)]),
            dependencies: {
                ...expired.deps,
                getCachedMedia: async () => null,
            },
        });
        const expiredResult = await expiredTool.execute({ message: 12, count: 1 }, AbortSignal.abort());
        expect(expiredResult.isError && expiredResult.content.includes('过期'), `expired media is named (got ${expiredResult.content})`);

        const photo = dependenciesWith(stub, { media: videoMedia({ kind: 'photo', mime: 'image/jpeg', data: PNG }) });
        const photoTool = toolWith(state, 12, photo.deps);
        const photoResult = await photoTool.execute({ message: 12, count: 1 }, AbortSignal.abort());
        expect(photoResult.isError && photoResult.content.includes('不是视频'), `a picture is refused clearly (got ${photoResult.content})`);
        expect(stub.calls.length === 0, 'the converter was never called');
    })
);

cases.push(
    await runCase('a time outside the clip comes back with the real duration', async () => {
        const state = createReplyMediaState();
        const stub = framesStub(() => ({
            ok: false,
            reason: 'invalid-time',
            message: 'time 30s is outside the video (0-8.2s)',
            duration: 8.2,
        }));
        const deps = dependenciesWith(stub);
        const tool = toolWith(state, 12, deps.deps);

        const result = await tool.execute({ message: 12, times: [30] }, AbortSignal.abort());
        expect(result.isError && result.content.includes('8.2s'), `the duration is repeated (got ${result.content})`);
        expect(state.fetched.size === 0, 'nothing was registered');
    })
);

cases.push(
    await runCase('the reply-wide cap counts frames across calls', async () => {
        const state = createReplyMediaState();
        const stub = framesStub(() => framesSuccess(Array.from({ length: 6 }, (_, index) => frameOf(index))));
        const deps = dependenciesWith(stub);
        const tool = toolWith(state, 12, deps.deps);

        const first = await tool.execute({ message: 12, count: 6 }, AbortSignal.abort());
        expect(!first.isError && first.modelImages?.length === 6, `six frames go out (got ${first.content})`);
        const second = await tool.execute({ message: 12, count: 1 }, AbortSignal.abort());
        expect(second.isError && second.content.includes('最多'), `the cap is explained (got ${second.content})`);
        expect(stub.calls.length === 1, 'the converter was called once');
        expect(state.fetched.size === MAX_FRAMES_PER_REPLY, 'exactly six imgN were registered');
    })
);

cases.push(
    await runCase('a failed extraction registers nothing', async () => {
        const state = createReplyMediaState();
        const stub = framesStub(() => ({ ok: false, reason: 'failed' }));
        const deps = dependenciesWith(stub);
        const tool = toolWith(state, 12, deps.deps);

        const result = await tool.execute({ message: 12, count: 1 }, AbortSignal.abort());
        expect(result.isError && result.content.includes('重试'), `the failure is explained (got ${result.content})`);
        expect(state.fetched.size === 0, 'no imgN was spent');
    })
);

cases.push(
    await runCase('the registered frames are resolvable by the reply image tools', async () => {
        const state = createReplyMediaState();
        const stub = framesStub(() => framesSuccess([frameOf(3.5, JPEG)]));
        const deps = dependenciesWith(stub);
        const tool = toolWith(state, 12, deps.deps);
        const result = await tool.execute({ message: 12, times: [3.5] }, AbortSignal.abort());
        expect(!result.isError, 'the frame was extracted');

        const resolved = await resolveMediaRef(
            { kind: 'id', id: 'img1' },
            {
                state,
                chatId: CHAT_ID,
                contextIndex: new Map(),
                dependencies: {
                    fetchImage: async () => ({
                        ok: true as const,
                        image: { data: JPEG, mimeType: 'image/jpeg' as const, finalUrl: 'https://example.com/a.jpg' },
                    }),
                    loadMessageImages: async () => [],
                },
            }
        );
        expect(resolved.ok && resolved.data.equals(JPEG), 'send_image/find_image resolve the frame bytes');
    })
);

reportResults(cases);
