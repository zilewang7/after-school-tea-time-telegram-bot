/**
 * Offline cases for animated (.tgs / Lottie) stickers: how the capture maps a
 * sticker to media, and how a failed full-clip render degrades to one still
 * frame instead of "you cannot see it".
 *
 * Run: npx tsx scripts/offline/animated-sticker.mts
 */
import type { Message as TgMessage } from 'grammy/types';
import { createServer, type Server } from 'node:http';
import {
    OFFLINE_CHAT_ID,
    expect,
    reportResults,
    runCase,
    setupOfflineDb,
    takeMessageId,
    type CaseResult,
} from './harness.mts';

/** The stub converter, snapshotted by tgs-client at import */
const CONVERTER_PORT = 9153;
process.env.TGS_CONVERTER_URL = `http://127.0.0.1:${CONVERTER_PORT}`;

for (const key of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GROK_API_KEY', 'MIMO_API_KEY']) {
    process.env[key] ||= 'offline-placeholder';
}

const db = await setupOfflineDb();
const { Message } = db;

const { materializeTgsMedia, mediaHintForAcquireResult, resolveCapturedMedia } = await import(
    '../../src/db/autoSave.js'
);
const { getCachedMedia } = await import('../../src/services/media-cache-service.js');
const { buildContext } = await import('../../src/reply/context-builder.js');
const { sequelize } = await import('../../src/db/config.js');

const TGS_BYTES = Buffer.from('offline tgs bytes');
const CLIP = Buffer.from('offline webm clip');
const STILL = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('still')]);

type ConverterReply = { convert: 'clip' | 'rejected'; still: 'png' | 'rejected' };

/** One long-lived stub: keep-alive sockets from a previous case would fail */
const currentReply: ConverterReply = { convert: 'clip', still: 'png' };
const converter = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
        const url = request.url ?? '';
        // A fresh connection per request keeps case boundaries honest
        response.setHeader('Connection', 'close');
        if (url.startsWith('/convert')) {
            if (currentReply.convert === 'rejected') {
                response.writeHead(422, { 'Content-Type': 'text/plain' });
                response.end('convert failed: TGS document exceeds 80000 JSON nodes');
                return;
            }
            response.writeHead(200, { 'Content-Type': 'video/webm' });
            response.end(CLIP);
            return;
        }
        if (url.startsWith('/still')) {
            if (currentReply.still === 'rejected') {
                response.writeHead(422, { 'Content-Type': 'text/plain' });
                response.end('still failed: TGS document exceeds 200000 JSON nodes');
                return;
            }
            response.writeHead(200, { 'Content-Type': 'image/png' });
            response.end(STILL);
            return;
        }
        if (url.startsWith('/normalize-video')) {
            response.writeHead(200, { 'Content-Type': 'video/webm', 'X-Normalized': '0' });
            response.end(CLIP);
            return;
        }
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end('unexpected endpoint');
    });
});
await new Promise<void>((resolve) => converter.listen(CONVERTER_PORT, '127.0.0.1', () => resolve()));

const withConverter = async <T>(reply: ConverterReply, body: () => Promise<T>): Promise<T> => {
    currentReply.convert = reply.convert;
    currentReply.still = reply.still;
    return body();
};

const stickerMessage = (uniqueId: string): TgMessage =>
    ({
        sticker: {
            file_id: `file-${uniqueId}`,
            file_unique_id: uniqueId,
            type: 'regular',
            width: 512,
            height: 512,
            is_animated: true,
            is_video: false,
            emoji: '🐬',
            file_size: TGS_BYTES.length,
        },
    }) as unknown as TgMessage;

const seedMessage = async (fileUniqueId: string, mediaHint: string): Promise<number> => {
    const messageId = takeMessageId();
    await Message.create({
        chatId: OFFLINE_CHAT_ID,
        messageId,
        fromBotSelf: false,
        userId: 42,
        date: new Date(messageId * 1000),
        userName: 'tester',
        text: '',
        quoteText: null,
        file: null,
        fileMime: 'image/png',
        fileUniqueId,
        replyToId: null,
        chatCommand: null,
        modelParts: null,
        mediaHint,
        forwardOrigin: null,
        forwardFromId: null,
        viaBot: null,
        ocrText: null,
    });
    return messageId;
};

const cases: CaseResult[] = [];

cases.push(
    await runCase('a .tgs sticker is captured as an animated sticker with a still fallback hint', async () => {
        const captured = resolveCapturedMedia(stickerMessage('capture-unique'));
        expect(captured?.kind === 'animated_sticker', `the kind is animated_sticker (got ${captured?.kind})`);
        expect(captured?.needsTgsConversion === true, 'it goes through the converter');
        expect(
            captured?.hint === 'an animated sticker (a short video clip, pack emoji: 🐬)',
            `the hint states the clip (got ${captured?.hint})`
        );
        expect(
            captured?.stillHint === 'an animated sticker (a still frame only — the animation could not be rendered, pack emoji: 🐬)',
            `the still hint states the fallback (got ${captured?.stillHint})`
        );
    })
);

cases.push(
    await runCase('a rejected clip render falls back to one cached still frame', async () => {
        await withConverter({ convert: 'rejected', still: 'png' }, async () => {
            const uniqueId = `still-${takeMessageId()}`;
            const captured = resolveCapturedMedia(stickerMessage(uniqueId));
            if (!captured) throw new Error('sticker was not captured');

            const outcome = await materializeTgsMedia(captured, TGS_BYTES);
            expect(outcome.status === 'cached_still', `the outcome is cached_still (got ${outcome.status})`);

            const cached = await getCachedMedia(uniqueId);
            expect(cached?.kind === 'animated_sticker_still', `the kind is a still (got ${cached?.kind})`);
            expect(cached?.mime === 'image/png', `the mime is image/png (got ${cached?.mime})`);
            expect(cached?.data?.equals(STILL) === true, 'the cached bytes are the rendered PNG');

            const hint = mediaHintForAcquireResult(captured, outcome);
            expect(hint === captured.stillHint, `the hint states the still (got ${hint})`);
            expect(!hint.includes('cannot see it'), 'the model is no longer told it cannot see the sticker');
        });
    })
);

cases.push(
    await runCase('a still-frame sticker enters the context as a picture, not as a clip', async () => {
        await withConverter({ convert: 'rejected', still: 'png' }, async () => {
            const uniqueId = `ctx-${takeMessageId()}`;
            const captured = resolveCapturedMedia(stickerMessage(uniqueId));
            if (!captured) throw new Error('sticker was not captured');
            const outcome = await materializeTgsMedia(captured, TGS_BYTES);
            const messageId = await seedMessage(uniqueId, mediaHintForAcquireResult(captured, outcome));
            const row = await Message.findOne({ where: { chatId: OFFLINE_CHAT_ID, messageId } });
            if (!row) throw new Error('seeded message not found');

            const { messages } = await buildContext(row);
            const parts = messages.flatMap((message) => message.content);
            const image = parts.find((part) => part.type === 'image');
            expect(image !== undefined, 'the still is an image part');
            expect(image?.mimeType === 'image/png', `the part carries image/png (got ${image?.mimeType})`);

            const texts = parts.map((part) => part.text ?? '').join('\n');
            expect(
                texts.includes("A sticker's pack emoji is loose metadata"),
                'the sticker emoji nudge still applies'
            );
            expect(
                !texts.includes('play it through to know what it really shows'),
                'a still is not announced as a clip to watch'
            );
        });
    })
);

cases.push(
    await runCase('a renderable clip stays a clip and keeps the plain hint', async () => {
        await withConverter({ convert: 'clip', still: 'png' }, async () => {
            const uniqueId = `clip-${takeMessageId()}`;
            const captured = resolveCapturedMedia(stickerMessage(uniqueId));
            if (!captured) throw new Error('sticker was not captured');

            const outcome = await materializeTgsMedia(captured, TGS_BYTES);
            expect(outcome.status === 'cached', `the outcome is cached (got ${outcome.status})`);

            const cached = await getCachedMedia(uniqueId);
            expect(cached?.kind === 'animated_sticker', `the kind stays animated_sticker (got ${cached?.kind})`);
            expect(cached?.mime === 'video/webm', `the mime is video/webm (got ${cached?.mime})`);
            expect(
                mediaHintForAcquireResult(captured, outcome) === captured.hint,
                'the hint does not mention a still'
            );
        });
    })
);

cases.push(
    await runCase('when both the clip and the still fail the sticker stays invisible and says so', async () => {
        await withConverter({ convert: 'rejected', still: 'rejected' }, async () => {
            const uniqueId = `fail-${takeMessageId()}`;
            const captured = resolveCapturedMedia(stickerMessage(uniqueId));
            if (!captured) throw new Error('sticker was not captured');

            const outcome = await materializeTgsMedia(captured, TGS_BYTES);
            expect(outcome.status === 'convert_failed', `the outcome is convert_failed (got ${outcome.status})`);
            expect((await getCachedMedia(uniqueId)) === null, 'nothing is cached');

            const hint = mediaHintForAcquireResult(captured, outcome);
            expect(hint.endsWith('— failed to render, you cannot see it'), `the hint is unchanged (got ${hint})`);
        });
    })
);

await new Promise<void>((resolve) => converter.close(() => resolve()));
await sequelize.close();

reportResults(cases);
