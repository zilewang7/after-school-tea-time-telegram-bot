/**
 * Offline cases for fetch_image's history lane.
 *
 * The luoxu client never runs: a fake service answers the manifest and the
 * bytes, and records which variant (original or thumbnail) was asked for. The
 * frame decoder is a stub for the same reason — the converter service is a
 * container.
 *
 * Run: npx tsx scripts/offline/history-image.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import type {
    HistoryImageBytes,
    HistoryImageItem,
    HistoryImageManifest,
    HistoryMedia,
    HistoryService,
} from '../../src/services/luoxu-history-service.js';

for (const key of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GROK_API_KEY', 'MIMO_API_KEY']) {
    process.env[key] ||= 'offline-placeholder';
}

const { createFetchImageTool } = await import('../../src/reply/tools/fetch-image-tool.js');
const { createReplyMediaState } = await import('../../src/reply/tools/reply-media-state.js');
const { createHistoryState } = await import('../../src/reply/tools/history-state.js');
const { loadHistoryImage } = await import('../../src/reply/tools/history-image.js');
const { parseFetchImageArgs } = await import('../../src/reply/tools/media-tool-args.js');
const { HistoryRequestError } = await import('../../src/services/luoxu-history-service.js');

const CHANNEL_ID = 1415974153;
const OTHER_CHANNEL_ID = 2311128579;
const OWNER_ID = 603421700;
const STRANGER_ID = 424242;
const MESSAGE_ID = 1115908;
const TZ = 'Asia/Shanghai';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const jpeg = (bytes = 400): Buffer =>
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(bytes)]);
const png = (): Buffer =>
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const webp = (): Buffer =>
    Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.from([0x10, 0x00, 0x00, 0x00]),
        Buffer.from('WEBPVP8 '),
        Buffer.alloc(32),
    ]);
/** Not an image: what an mp4 looks like to the sniffer */
const mp4 = (): Buffer =>
    Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(64)]);
const heic = (): Buffer => Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypheic')]);

const photoItem = (overrides: Partial<HistoryImageItem> = {}): HistoryImageItem => ({
    which: 'media',
    source: 'media',
    kind: 'photo',
    mime: 'image/jpeg',
    size: 212_204,
    width: 2560,
    height: 1293,
    duration: null,
    fileName: null,
    ...overrides,
});

const previewItem = (): HistoryImageItem => ({
    which: 'photo',
    source: 'preview',
    kind: 'photo',
    mime: 'image/jpeg',
    size: 9473,
    width: 200,
    height: 200,
    duration: null,
    fileName: null,
});

const pageItem = (): HistoryImageItem => ({
    which: 'page_photo_0',
    source: 'page',
    kind: 'photo',
    mime: 'image/jpeg',
    size: 5120,
    width: 800,
    height: 600,
    duration: null,
    fileName: null,
});

const videoItem = (): HistoryImageItem => ({
    which: 'media',
    source: 'media',
    kind: 'video',
    mime: 'video/mp4',
    size: 50 * 1024 * 1024,
    width: 1280,
    height: 720,
    duration: 12.5,
    fileName: null,
});

interface FakeHistory {
    readonly service: HistoryService;
    readonly manifests: { channelId: number; messageId: number }[];
    readonly byteCalls: { which: string; thumb: boolean }[];
}

const fakeHistory = (options: {
    readonly images: readonly HistoryImageItem[];
    readonly media?: HistoryMedia | null;
    readonly bytes?: (which: string, thumb: boolean) => HistoryImageBytes | null;
}): FakeHistory => {
    const manifests: { channelId: number; messageId: number }[] = [];
    const byteCalls: { which: string; thumb: boolean }[] = [];
    const service: HistoryService = {
        search: async () => {
            throw new Error('offline: search is not part of this lane');
        },
        findSenders: async () => [],
        messages: async () => [],
        stats: async () => ({ groups: [] }),
        images: async (channelId, messageId): Promise<HistoryImageManifest> => {
            manifests.push({ channelId, messageId });
            return { images: options.images, media: options.media ?? null };
        },
        imageBytes: async (_channelId, _messageId, which, callOptions) => {
            const thumb = callOptions?.thumb === true;
            byteCalls.push({ which, thumb });
            return options.bytes ? options.bytes(which, thumb) : { data: jpeg(), mime: 'image/jpeg' };
        },
    };
    return { service, manifests, byteCalls };
};

/** An `h1` pointing at MESSAGE_ID, the way a search would have left it */
const stateWithHit = () => {
    const state = createHistoryState();
    state.remember({
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
        timestamp: 1_793_949_130,
        fromId: OWNER_ID,
        fromName: '黑猫',
        fromIsBot: false,
        indexedHtml: '[image]',
    });
    return state;
};

interface OptionsInput {
    readonly history: FakeHistory;
    readonly requesterUserId?: number | null;
    readonly ownerUserId?: number | null;
    readonly extractFrame?: (video: Buffer, mime: string) => Promise<{ data: Buffer; mimeType: 'image/png' | 'image/jpeg' } | null>;
}

const buildOptions = (input: OptionsInput) => ({
    state: stateWithHit(),
    service: input.history.service,
    channelId: CHANNEL_ID,
    ownerUserId: input.ownerUserId === undefined ? OWNER_ID : input.ownerUserId,
    requesterUserId: input.requesterUserId === undefined ? OWNER_ID : input.requesterUserId,
    ...(input.extractFrame === undefined
        ? {}
        : { extractFrame: async (video: Buffer, mime: string) => input.extractFrame?.(video, mime) ?? null }),
});

const signal = (): AbortSignal => new AbortController().signal;

const cases: CaseResult[] = [];

cases.push(
    await runCase('a photo of an archived message is read as its own picture', async () => {
        const history = fakeHistory({ images: [photoItem(), previewItem(), pageItem()] });
        const result = await loadHistoryImage(buildOptions({ history }), 'h1', 1, 'original', signal());
        expect(result.ok, `the read succeeds (${result.ok ? '' : result.error})`);
        if (!result.ok) return;
        expect(result.image.mimeType === 'image/jpeg', 'the bytes are sniffed as a JPEG');
        expect(result.image.label === '消息图片', 'the own attachment is labelled');
        expect(result.image.index === 1 && result.image.total === 3, 'it is the first of three');
        expect(result.image.reference === 'h1', 'the reference the model used is kept');
        expect(
            result.image.sourcePage === `https://t.me/c/${CHANNEL_ID}/${MESSAGE_ID}`,
            'the source page is the message link'
        );
        expect(history.manifests[0]?.channelId === CHANNEL_ID, 'the manifest is asked for the right channel');
        expect(history.byteCalls[0]?.thumb === false, 'the original is requested by default');
    })
);

cases.push(
    await runCase('image picks the n-th picture of that message', async () => {
        const history = fakeHistory({ images: [photoItem(), previewItem(), pageItem()] });
        const result = await loadHistoryImage(buildOptions({ history }), 'h1', 2, 'original', signal());
        expect(result.ok, 'the second picture is readable');
        if (!result.ok) return;
        expect(result.image.label === '网页预览图', 'a preview picture says so');
        expect(history.byteCalls[0]?.which === 'photo', 'the manifest locator is forwarded');
    })
);

cases.push(
    await runCase('an index past the last picture names what is there', async () => {
        const history = fakeHistory({ images: [photoItem(), pageItem()] });
        const result = await loadHistoryImage(buildOptions({ history }), 'h1', 3, 'original', signal());
        expect(!result.ok, 'it is refused');
        if (result.ok) return;
        expect(result.error.includes('只有 2 张图'), 'the count is stated');
        expect(result.error.includes('Instant View 第 1 张图'), 'the pictures are listed');
    })
);

cases.push(
    await runCase('a message without pictures says what it does carry', async () => {
        const video: HistoryMedia = {
            type: 'video',
            mime: 'video/mp4',
            size: 1024,
            duration: 9,
            stickerEmoji: null,
            fileName: null,
            voice: false,
        };
        const history = fakeHistory({ images: [], media: video });
        const result = await loadHistoryImage(buildOptions({ history }), 'h1', 1, 'original', signal());
        expect(!result.ok, 'there is nothing to read');
        if (result.ok) return;
        expect(result.error.includes('没有图片'), 'the absence is stated');
        expect(result.error.includes('a video'), 'and the medium it does carry');
    })
);

cases.push(
    await runCase('a context number is not a history reference', async () => {
        const history = fakeHistory({ images: [photoItem()] });
        const result = await loadHistoryImage(buildOptions({ history }), '#12', 1, 'original', signal());
        expect(!result.ok, 'it is refused');
        if (result.ok) return;
        expect(result.error.includes('上下文'), 'the reason points at the context');
        expect(history.manifests.length === 0, 'nothing is fetched');
    })
);

cases.push(
    await runCase('an unknown hN is refused before any request', async () => {
        const history = fakeHistory({ images: [photoItem()] });
        const result = await loadHistoryImage(buildOptions({ history }), 'h9', 1, 'original', signal());
        expect(!result.ok && result.error.includes('没有 h9'), 'the missing number is named');
        expect(history.manifests.length === 0, 'nothing is fetched');
    })
);

cases.push(
    await runCase('a link into another group is owner-only', async () => {
        const link = `https://t.me/c/${OTHER_CHANNEL_ID}/42`;
        const stranger = await loadHistoryImage(
            buildOptions({ history: fakeHistory({ images: [photoItem()] }), requesterUserId: STRANGER_ID }),
            link,
            1,
            'original',
            signal()
        );
        expect(!stranger.ok && stranger.error.includes('只能读取本群'), 'a stranger is refused');

        const owner = await loadHistoryImage(
            buildOptions({ history: fakeHistory({ images: [photoItem()] }), requesterUserId: OWNER_ID }),
            link,
            1,
            'original',
            signal()
        );
        expect(owner.ok, 'the owner may read it');
    })
);

cases.push(
    await runCase('a video is read from its thumbnail, not as video', async () => {
        const history = fakeHistory({
            images: [videoItem()],
            bytes: (_which, thumb) => (thumb ? { data: jpeg(), mime: 'image/jpeg' } : { data: mp4(), mime: 'video/mp4' }),
        });
        const result = await loadHistoryImage(buildOptions({ history }), 'h1', 1, 'original', signal());
        expect(result.ok, `the still is read (${result.ok ? '' : result.error})`);
        if (!result.ok) return;
        expect(history.byteCalls[0]?.thumb === true, 'the cheap variant is asked for');
        expect(result.image.mimeType === 'image/jpeg', 'a JPEG still comes back');
        expect(result.image.note === '动图/视频的首帧', 'the result says it is a frame');
    })
);

cases.push(
    await runCase('a video without a thumbnail is decoded to its first frame', async () => {
        const history = fakeHistory({
            images: [videoItem()],
            // luoxu falls back to the original when Telegram kept no thumbnail
            bytes: () => ({ data: mp4(), mime: 'video/mp4' }),
        });
        let decoded = 0;
        const result = await loadHistoryImage(
            buildOptions({
                history,
                extractFrame: async () => {
                    decoded += 1;
                    return { data: png(), mimeType: 'image/png' };
                },
            }),
            'h1',
            1,
            'original',
            signal()
        );
        expect(result.ok, `the frame stands in (${result.ok ? '' : result.error})`);
        if (!result.ok) return;
        expect(decoded === 1, 'the decoder ran once');
        expect(result.image.mimeType === 'image/png', 'the frame format is kept');
        expect(result.image.note === '动图/视频的首帧', 'the result says it is a frame');
    })
);

cases.push(
    await runCase('an unreadable original falls back to the kept thumbnail', async () => {
        const history = fakeHistory({
            images: [photoItem({ mime: 'image/heic', size: 4096 })],
            bytes: (_which, thumb) =>
                thumb ? { data: jpeg(), mime: 'image/jpeg' } : { data: heic(), mime: 'image/heic' },
        });
        const result = await loadHistoryImage(buildOptions({ history }), 'h1', 1, 'original', signal());
        expect(result.ok, `the thumbnail is used (${result.ok ? '' : result.error})`);
        if (!result.ok) return;
        expect(history.byteCalls.length === 2, 'the original and then the thumbnail are fetched');
        expect(history.byteCalls[1]?.thumb === true, 'the second attempt asks for the thumbnail');
        expect(result.image.note === '原格式读不了，给你的是缩略图', 'the reason is stated');
    })
);

cases.push(
    await runCase('an oversized original is downgraded to its thumbnail', async () => {
        const big = 12 * 1024 * 1024;
        const history = fakeHistory({
            images: [photoItem({ size: big })],
            bytes: (_which, thumb) =>
                thumb
                    ? { data: jpeg(2000), mime: 'image/jpeg' }
                    : { data: jpeg(big), mime: 'image/jpeg' },
        });
        const result = await loadHistoryImage(buildOptions({ history }), 'h1', 1, 'original', signal());
        expect(result.ok, 'the picture is read');
        if (!result.ok) return;
        expect(history.byteCalls[0]?.thumb === true, 'the thumbnail is asked for without downloading 12MB');
        expect(result.image.note?.includes('12MB') === true, `the note names the original size (got ${result.image.note})`);
    })
);

cases.push(
    await runCase('a luoxu failure becomes one sentence', async () => {
        const history = fakeHistory({ images: [photoItem()] });
        const failing: HistoryService = {
            ...history.service,
            images: async () => {
                throw new HistoryRequestError('missing', 'gone');
            },
        };
        const result = await loadHistoryImage(
            buildOptions({ history: { ...history, service: failing } }),
            'h1',
            1,
            'original',
            signal()
        );
        expect(!result.ok, 'it is refused');
        if (result.ok) return;
        expect(result.error.includes('读不到了'), `a deleted message is explained (got ${result.error})`);
    })
);

cases.push(
    await runCase('the fetch_image tool registers a history picture as imgN', async () => {
        const history = fakeHistory({ images: [photoItem(), previewItem()] });
        const state = createReplyMediaState();
        const tool = createFetchImageTool({
            state,
            dependencies: { fetchImage: async () => ({ ok: false, error: 'offline: no network' }) },
            history: buildOptions({ history }),
        });
        const result = await tool.execute({ history: 'h1' }, signal());
        expect(!result.isError, `the call succeeds (${result.content})`);
        expect(result.content.includes('已读取 img1'), 'the picture gets an id');
        expect(result.content.includes('第 1/2 张'), 'its position is stated');
        expect(result.content.includes('这条消息共 2 张图'), 'the other pictures are listed');
        expect(result.modelImages?.[0]?.mimeType === 'image/jpeg', 'the model is handed the bytes');
        const fetched = state.fetched.get('img1');
        expect(fetched?.sourcePage === `https://t.me/c/${CHANNEL_ID}/${MESSAGE_ID}`, 'the id carries the source page');
        expect(result.record?.citations?.[0]?.uri === fetched?.sourcePage, 'the record cites the message');
    })
);

cases.push(
    await runCase('history arguments are one source among five', async () => {
        expect(parseFetchImageArgs({ history: 'h3' }).ok, 'history alone is accepted');
        expect(!parseFetchImageArgs({ history: 'h3', url: 'https://example.com/a.png' }).ok, 'two sources are refused');
        expect(!parseFetchImageArgs({}).ok, 'no source is refused');
        expect(!parseFetchImageArgs({ image: 2 }).ok, 'image alone is refused');
        const withIndex = parseFetchImageArgs({ history: 'h3', image: 2 });
        expect(withIndex.ok && withIndex.args.image === 2, 'image rides with history');
        expect(parseFetchImageArgs({ history: 'h3' }).ok, 'the default index is implicit');
    })
);

reportResults(cases);
