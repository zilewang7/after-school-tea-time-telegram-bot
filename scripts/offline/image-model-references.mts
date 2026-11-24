/**
 * Harness issue #17: an image model's reference images must reach images.edit.
 *
 * `vision` is a chat-facing capability (reading an image inside a conversation),
 * so the capability seed keeps it false for gpt-image-2.5-dev even though the
 * model clearly takes references. The platform factory therefore must not apply
 * the chat capability filter to an image-model request: before the fix it
 * stripped every reference image, generate_image and /picgpt silently became
 * text-to-image, and the platform logged `referenceImageCount: 0`.
 *
 * This file drives the real sendMessage against an images stub and checks the
 * wire (path, multipart name and type) and the platform's own count; the last
 * case is the guard clause: a chat request to a vision:false model still loses
 * its images.
 *
 * Run: npx tsx scripts/offline/image-model-references.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import { startStubServer } from './support/stub-server.mts';
import type { StreamChunk, UnifiedMessage } from '../../src/ai/types.js';

// A 1x1 lossless WebP (the format a sticker's original picture has) and the PNG
// the stub answers with; only their signatures matter here
const WEBP_BASE64 = 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==';
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=';

interface StubRequest {
    readonly path: string;
    readonly contentType: string;
    readonly body: Buffer;
}

const stubRequests: StubRequest[] = [];
const stub = await startStubServer();
stub.handle((request, response) => {
    const parts: Buffer[] = [];
    request.on('data', (part: Buffer) => parts.push(part));
    request.on('end', () => {
        const path = new URL(request.url ?? '/', 'http://stub').pathname;
        stubRequests.push({
            path,
            contentType: request.headers['content-type'] ?? '',
            body: Buffer.concat(parts),
        });
        // Both images paths answer the same: an image model's reply is its picture
        if (path === '/v1/images/generations' || path === '/v1/images/edits') {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ created: 0, data: [{ b64_json: PNG_BASE64 }] }));
            return;
        }
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: `unexpected request to ${path}` } }));
    });
});

// Read by the platform singletons when they are first imported
process.env.OPENAI_API_URL = `${stub.url}/v1`;
process.env.OPENAI_API_KEY = 'offline-stub';

await setupOfflineDb();
const { sendMessage } = await import('../../src/ai/platform-factory.js');
const { applyModelCapabilities } = await import('../../src/ai/message-transformer.js');
const { capabilitiesOf, resolveRuntimeTraits } = await import('../../src/ai/model-traits.js');
const { OPENAI_IMAGE_MODEL } = await import('../../src/config/models.js');

/** Console output while `body` runs, kept instead of printed; objects stay readable */
const capture = async <T,>(body: () => Promise<T>): Promise<{ result: T; lines: string[] }> => {
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    const describe = (arg: unknown): string => {
        if (arg instanceof Error) return arg.message;
        if (typeof arg === 'object' && arg !== null) return JSON.stringify(arg);
        return String(arg);
    };
    const record = (...args: unknown[]): void => {
        lines.push(args.map(describe).join(' '));
    };
    console.log = record;
    console.warn = record;
    console.error = record;
    try {
        return { result: await body(), lines };
    } finally {
        Object.assign(console, original);
    }
};

/** One image-model request through the platform factory: its chunks and its log */
const drawWithReferences = async (
    content: UnifiedMessage['content']
): Promise<{ chunks: StreamChunk[]; lines: string[] }> => {
    stubRequests.length = 0;
    const { result, lines } = await capture(async () => {
        const stream = await sendMessage(
            [{ role: 'user', content }],
            { model: OPENAI_IMAGE_MODEL, signal: AbortSignal.timeout(20_000) }
        );
        const chunks: StreamChunk[] = [];
        for await (const chunk of stream) chunks.push(chunk);
        return chunks;
    });
    return { chunks: result, lines };
};

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'a reference image goes to images.edit (multipart) with its own name and type, never images.generate',
        body: async () => {
            const webp = Buffer.from(WEBP_BASE64, 'base64');
            const prompt = '把这只猫画成油画';
            const { chunks, lines } = await drawWithReferences([
                { type: 'image', imageData: webp.toString('base64'), mimeType: 'image/webp', sizeBytes: webp.length },
                { type: 'text', text: prompt },
            ]);

            const [request] = stubRequests;
            expect(stubRequests.length === 1, `one request went out (got ${stubRequests.length})`);
            expect(
                request?.path === '/v1/images/edits',
                `the reference makes it images.edit, not images.generate (got ${request?.path ?? 'no request'})`
            );
            expect(
                request?.contentType.startsWith('multipart/form-data; boundary=') === true,
                `the edit request is multipart (got ${request?.contentType ?? 'no request'})`
            );
            // latin1 keeps the binary image part readable for the headers; the
            // prompt itself is utf8
            const body = request?.body.toString('latin1') ?? '';
            expect(
                body.includes('reference_0.webp') && body.includes('image/webp'),
                'the upload keeps the webp file name and media type (the sticker original is not relabelled png)'
            );
            expect(request?.body.toString('utf8').includes(prompt) === true, 'the prompt rides the same request');

            const image = chunks.find((chunk) => chunk.type === 'image');
            expect(
                image?.imageData?.equals(Buffer.from(PNG_BASE64, 'base64')) === true && chunks.at(-1)?.type === 'done',
                `the stub picture comes back (got ${chunks.map((chunk) => chunk.type).join(',')})`
            );
            expect(
                lines.some((line) => line.includes('[openai] Image generation:') && line.includes('"referenceImageCount":1')),
                `the platform counted the reference (got ${lines.filter((line) => line.includes('Image generation')).join(' | ')})`
            );
        },
    },
    {
        name: 'an inline reference without a declared mime is sniffed: /picgpt sends its webp as .webp too',
        body: async () => {
            // /picgpt and its retry build `{ type: 'image', imageData }` with no mime
            const webp = Buffer.from(WEBP_BASE64, 'base64');
            const { chunks, lines } = await drawWithReferences([
                { type: 'text', text: '再画一张' },
                { type: 'image', imageData: webp.toString('base64') },
            ]);

            const [request] = stubRequests;
            expect(stubRequests.length === 1, `one request went out (got ${stubRequests.length})`);
            expect(request?.path === '/v1/images/edits', `the bytes alone still make it images.edit (got ${request?.path})`);
            expect(
                request?.body.toString('latin1').includes('reference_0.webp'),
                'the sniffed bytes name the upload .webp'
            );
            expect(
                lines.some((line) => line.includes('[openai] Image generation:') && line.includes('"referenceImageCount":1')),
                'the platform counted the image part'
            );
            expect(chunks.some((chunk) => chunk.type === 'image'), 'and the picture comes back');

            // Without a reference the same path stays text-to-image
            stubRequests.length = 0;
            const { result: plainChunks } = await capture(async () => {
                const stream = await sendMessage(
                    [{ role: 'user', content: [{ type: 'text', text: '从零画一只猫' }] }],
                    { model: OPENAI_IMAGE_MODEL, signal: AbortSignal.timeout(20_000) }
                );
                const collected: StreamChunk[] = [];
                for await (const chunk of stream) collected.push(chunk);
                return collected;
            });
            expect(stubRequests[0]?.path === '/v1/images/generations', `no reference stays images.generate (got ${stubRequests[0]?.path})`);
            expect(plainChunks.some((chunk) => chunk.type === 'image'), 'and still draws');
        },
    },
    {
        name: 'the chat guard: a vision:false chat model still loses its images; only the image model skips the filter',
        body: async () => {
            const imageModelCapabilities = capabilitiesOf(resolveRuntimeTraits(OPENAI_IMAGE_MODEL));
            expect(
                imageModelCapabilities.supportsImageInput === false,
                'the capability seed still says the gpt image model does not read images (the seed is chat semantics)'
            );
            const chatCapabilities = capabilitiesOf(resolveRuntimeTraits('grok-3-mini'));
            expect(chatCapabilities.supportsImageInput === false, 'a chat model whose code traits carry vision:false');

            const messages: UnifiedMessage[] = [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: '看图' },
                        { type: 'image', imageData: WEBP_BASE64, mimeType: 'image/webp' },
                    ],
                    modelParts: [{ text: '' }],
                },
            ];
            const filtered = applyModelCapabilities(messages, chatCapabilities);
            expect(
                filtered[0]?.content.length === 1 &&
                    filtered[0].content[0]?.type === 'text' &&
                    filtered[0].modelParts === undefined,
                `a chat request to a vision:false model still loses its image and model parts (got ${JSON.stringify(filtered)})`
            );
            // What the factory no longer applies to an image model: the same
            // filter would be the bug (the seed says vision:false for it too)
            const wronglyFiltered = applyModelCapabilities(messages, imageModelCapabilities);
            expect(
                wronglyFiltered[0]?.content.every((part) => part.type === 'text') === true,
                'on the image model that filter would strip every reference — which is why sendMessage skips it there'
            );
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
await stub.close();
reportResults(results);
