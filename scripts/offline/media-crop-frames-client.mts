/**
 * Offline cases for the converter client side of crop/frames: the query the
 * bot sends, the response headers/JSON it reads back, the structured 422
 * answers, and the prompt lines that must appear exactly when the tools do.
 *
 * Run: npx tsx scripts/offline/media-crop-frames-client.mts
 *
 * The converter is a local stub: no ffmpeg, no database, no network.
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import { startStubServer, type StubHandler } from './support/stub-server.mts';

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('offline jpeg frame')]);
const MP4 = Buffer.from('offline video bytes');

// The platforms build their clients at import time; nothing here sends a request
for (const key of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GROK_API_KEY', 'MIMO_API_KEY']) {
    process.env[key] ||= 'offline-placeholder';
}

/** The client snapshots the converter URL at import, so the stub starts first */
const converter = await startStubServer();
process.env.TGS_CONVERTER_URL = converter.url;

const { cropImage, extractVideoFrames, isTgsConverterConfigured } = await import('../../src/services/tgs-client.js');
const { RESERVED_TOOL_NAMES } = await import('../../src/reply/tools/tool-names.js');
const { buildStaticSystemPrompt } = await import('../../src/ai/system-prompt/builder.js');

interface Captured {
    readonly path: string;
    readonly query: URLSearchParams;
    readonly body: Buffer;
}

/** One request captured; the handler answers with the case's response */
const withConverter = async (
    answer: (request: Captured, response: Parameters<StubHandler>[1]) => void,
    body: (captured: readonly Captured[]) => Promise<void>
): Promise<void> => {
    const captured: Captured[] = [];
    converter.handle((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
            const url = new URL(request.url ?? '/', 'http://localhost');
            const entry: Captured = {
                path: url.pathname,
                query: url.searchParams,
                body: Buffer.concat(chunks),
            };
            captured.push(entry);
            response.setHeader('Connection', 'close');
            answer(entry, response);
        });
    });
    try {
        await body(captured);
    } finally {
        converter.reset();
    }
};

const json = (response: Parameters<StubHandler>[1], status: number, payload: unknown): void => {
    const text = JSON.stringify(payload);
    response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    response.end(text);
};

const cases: CaseResult[] = [];

cases.push(
    await runCase('cropImage sends the box and reads the dimensions back from headers', async () => {
        await withConverter(
            (_request, response) => {
                response.writeHead(200, {
                    'Content-Type': 'image/png',
                    'Content-Length': PNG.length,
                    'X-Source-Width': '1200',
                    'X-Source-Height': '800',
                    'X-Crop-X1': '800',
                    'X-Crop-Y1': '534',
                    'X-Crop-X2': '1200',
                    'X-Crop-Y2': '800',
                    'X-Output-Width': '1024',
                    'X-Output-Height': '681',
                    'X-Crop-Flags': 'upscaled',
                });
                response.end(PNG);
            },
            async (captured) => {
                const outcome = await cropImage({
                    data: PNG,
                    x1: 667,
                    y1: 667,
                    x2: 1000,
                    y2: 1000,
                    unit: 'norm1000',
                });
                const request = captured[0];
                expect(request?.path === '/crop', 'the crop endpoint was called');
                expect(
                    request?.query.get('unit') === 'norm1000'
                        && request?.query.get('x1') === '667'
                        && request?.query.get('y2') === '1000',
                    'the box and unit travel in the query'
                );
                expect(request?.body.equals(PNG) === true, 'the source bytes are the body');
                expect(outcome.ok, `the outcome is a success (got ${JSON.stringify(outcome)})`);
                if (!outcome.ok) return;
                expect(outcome.data.equals(PNG), 'the encoded crop is returned');
                expect(
                    outcome.sourceWidth === 1200
                        && outcome.sourceHeight === 800
                        && outcome.box.x1 === 800
                        && outcome.box.y2 === 800
                        && outcome.outputWidth === 1024
                        && outcome.outputHeight === 681,
                    'the dimensions and the used box come from the headers'
                );
                expect(outcome.flags.join(',') === 'upscaled', 'the flags are carried');
            }
        );
    })
);

cases.push(
    await runCase('a 422 box carries the source dimensions to correct by', async () => {
        await withConverter(
            (_request, response) => json(response, 422, { error: 'crop is too small', width: 1200, height: 800 }),
            async () => {
                const outcome = await cropImage({
                    data: PNG,
                    x1: 0,
                    y1: 0,
                    x2: 50,
                    y2: 50,
                    unit: 'norm1000',
                });
                expect(!outcome.ok && outcome.reason === 'invalid-box', 'the failure is invalid-box');
                if (outcome.ok) return;
                expect(outcome.sourceWidth === 1200 && outcome.sourceHeight === 800, 'the dimensions come through');
                expect(outcome.message === 'crop is too small', 'the sidecar message comes through');
            }
        );
    })
);

cases.push(
    await runCase('a converter error is a plain failed outcome', async () => {
        await withConverter(
            (_request, response) => {
                response.writeHead(500, { 'Content-Type': 'text/plain' });
                response.end('crop failed: boom');
            },
            async () => {
                const outcome = await cropImage({ data: PNG, x1: 0, y1: 0, x2: 900, y2: 900, unit: 'norm1000' });
                expect(!outcome.ok && outcome.reason === 'failed', 'the failure is failed');
            }
        );
    })
);

cases.push(
    await runCase('extractVideoFrames sends bytes and parses the JSON frames', async () => {
        await withConverter(
            (_request, response) =>
                json(response, 200, {
                    duration: 12.34,
                    width: 720,
                    height: 1280,
                    fps: 30,
                    rotation: 0,
                    frames: [
                        { requestedT: 3.5, actualT: 3.5, mime: 'image/png', width: 960, height: 540, data: PNG.toString('base64') },
                        { requestedT: 12, actualT: 12.04, mime: 'image/jpeg', width: 960, height: 540, data: JPEG.toString('base64') },
                    ],
                    notes: ['补帧视频末帧'],
                }),
            async (captured) => {
                const outcome = await extractVideoFrames({
                    source: { kind: 'bytes', data: MP4, mimeType: 'video/mp4' },
                    mode: 'times',
                    times: [3.5, 12],
                    size: 960,
                });
                const request = captured[0];
                expect(request?.path === '/frames', 'the frames endpoint was called');
                expect(
                    request?.query.get('mode') === 'times' && request?.query.get('times') === '3.5,12',
                    'the requested times travel in the query'
                );
                expect(request?.query.get('size') === '960', 'the size travels in the query');
                expect(request?.body.equals(MP4) === true, 'the video bytes are the body');
                expect(outcome.ok, `the outcome is a success (got ${JSON.stringify(outcome)})`);
                if (!outcome.ok) return;
                expect(outcome.duration === 12.34 && outcome.width === 720, 'the clip metadata is parsed');
                expect(outcome.frames.length === 2, 'two frames are parsed');
                expect(outcome.frames[0]?.data.equals(PNG), 'the first frame bytes decode');
                expect(outcome.frames[1]?.mimeType === 'image/jpeg', 'the second frame keeps its mime');
                expect(outcome.frames[1]?.actualT === 12.04, 'the actual time is carried');
                expect(outcome.notes.join(';') === '补帧视频末帧', 'the notes are carried');
            }
        );
    })
);

cases.push(
    await runCase('a >20MB source is sent as a signed URL, not as bytes', async () => {
        const signedUrl = 'https://storage.googleapis.com/bucket/large.mp4?X-Goog-Signature=abc';
        await withConverter(
            (_request, response) =>
                json(response, 200, {
                    duration: 600,
                    width: 1280,
                    height: 720,
                    fps: 24,
                    rotation: 0,
                    frames: [
                        { requestedT: 300, actualT: 300.04, mime: 'image/jpeg', width: 960, height: 540, data: JPEG.toString('base64') },
                    ],
                    notes: [],
                }),
            async (captured) => {
                const outcome = await extractVideoFrames({
                    source: {
                        kind: 'url',
                        url: signedUrl,
                        mimeType: 'video/mp4',
                        sourceBytes: 200 * 1024 * 1024,
                    },
                    mode: 'times',
                    times: [300],
                });
                const request = captured[0];
                expect(request?.query.get('url') === signedUrl, 'the signed URL travels as its own parameter');
                expect(request?.query.get('sourceBytes') === String(200 * 1024 * 1024), 'the size hint travels along');
                expect(request?.body.length === 0, 'the bot does not upload the large video');
                expect(outcome.ok, `the outcome is a success (got ${JSON.stringify(outcome)})`);
            }
        );
    })
);

cases.push(
    await runCase('a 422 time error carries the clip duration', async () => {
        await withConverter(
            (_request, response) => json(response, 422, { error: 'time 30s is outside the video (0-8.2s)', duration: 8.2 }),
            async () => {
                const outcome = await extractVideoFrames({
                    source: { kind: 'bytes', data: MP4, mimeType: 'video/mp4' },
                    mode: 'times',
                    times: [30],
                });
                expect(!outcome.ok && outcome.reason === 'invalid-time', 'the failure is invalid-time');
                if (outcome.ok) return;
                expect(outcome.duration === 8.2, 'the duration comes through for the message');
            }
        );
    })
);

cases.push(
    await runCase('unreadable converter JSON is a plain failed outcome', async () => {
        await withConverter(
            (_request, response) => {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end('not json');
            },
            async () => {
                const outcome = await extractVideoFrames({
                    source: { kind: 'bytes', data: MP4, mimeType: 'video/mp4' },
                    mode: 'first',
                });
                expect(!outcome.ok && outcome.reason === 'failed', 'the failure is failed');
            }
        );
    })
);

cases.push(
    await runCase('the converter is configured and the tool names are reserved', async () => {
        expect(isTgsConverterConfigured(), 'a TGS_CONVERTER_URL means the media tools may be offered');
        expect(
            RESERVED_TOOL_NAMES.includes('crop_image') && RESERVED_TOOL_NAMES.includes('extract_frames'),
            'MCP tools cannot take either name'
        );
    })
);

cases.push(
    await runCase('the prompt names each tool exactly when it is offered', async () => {
        const full = buildStaticSystemPrompt('gemini-4-carbon', {
            imageTools: true,
            imageFetch: true,
            imageCrop: true,
            imageFrames: true,
        });
        expect(full.includes('`crop_image`'), 'crop_image is named when offered');
        expect(full.includes('`extract_frames`'), 'extract_frames is named when offered');
        const bare = buildStaticSystemPrompt('gemini-4-carbon', {
            imageTools: true,
            imageFetch: true,
        });
        expect(!bare.includes('`crop_image`') && !bare.includes('`extract_frames`'), 'neither is named when not offered');
    })
);

await converter.close();
reportResults(cases);
