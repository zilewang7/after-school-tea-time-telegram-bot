/**
 * Offline cases for animated (GIF / animated sticker) messages: how they are
 * captured, how their first frame stands in for a picture, and the once-only
 * backfill that makes historical rows behave the same as new ones.
 *
 * Run: npx tsx scripts/offline/animation-frame.mts
 */
import type { Message as TgMessage } from 'grammy/types';
import {
    OFFLINE_CHAT_ID,
    expect,
    reportResults,
    runCase,
    setupOfflineDb,
    takeMessageId,
    type CaseResult,
} from './harness.mts';
import type { ContextIndexEntry } from '../../src/reply/context-index.js';

for (const key of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GROK_API_KEY', 'MIMO_API_KEY']) {
    process.env[key] ||= 'offline-placeholder';
}

const db = await setupOfflineDb();
const { Message, putCachedMedia } = db;

const { resolveCapturedMedia } = await import('../../src/db/autoSave.js');
const { createAnimationFrameLoader } = await import('../../src/reply/tools/animation-frame.js');
const { loadContextImages } = await import('../../src/reply/tools/image-references.js');
const { getCachedMedia } = await import('../../src/services/media-cache-service.js');
const { backfillAnimationMediaKind } = await import('../../src/db/schema-migrations.js');
const { sequelize } = await import('../../src/db/config.js');
const { getMessage } = await import('../../src/db/index.js');

/** JPEG magic is all the tools sniff */
const FRAME = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF frame')]);
const VIDEO = Buffer.from('offline mp4 bytes');

const seedMessage = async (
    fileUniqueId: string,
    mediaHint: string | null = null
): Promise<number> => {
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
        fileMime: 'video/mp4',
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
    await runCase('an animation is captured as an animation, not as a document', async () => {
        const gif = {
            animation: {
                file_id: 'anim-file',
                file_unique_id: 'anim-unique',
                file_name: 'animation.gif.mp4',
                mime_type: 'video/mp4',
                duration: 9,
                width: 320,
                height: 282,
                file_size: 579,
            },
            // Bot API sets document too, for backward compatibility
            document: {
                file_id: 'anim-file',
                file_unique_id: 'anim-unique',
                file_name: 'animation.gif.mp4',
                mime_type: 'video/mp4',
                file_size: 579,
            },
        } as unknown as TgMessage;
        const captured = resolveCapturedMedia(gif);
        expect(captured?.kind === 'animation', `the kind is animation (got ${captured?.kind})`);
        expect(captured?.hint === 'an animation', `the hint states the medium (got ${captured?.hint})`);
        expect(captured?.durationSeconds === 9, 'the duration is kept');
        expect(captured?.mime === 'video/mp4', 'the mime is the converted mp4');
        expect(captured?.fileUniqueId === 'anim-unique', 'the cache key is the animation file');

        const file = {
            document: {
                file_id: 'doc-file',
                file_unique_id: 'doc-unique',
                file_name: 'clip.mp4',
                mime_type: 'video/mp4',
            },
        } as unknown as TgMessage;
        const document = resolveCapturedMedia(file);
        expect(document?.kind === 'document', 'a plain mp4 stays a document');
        expect(document?.hint === 'a file: clip.mp4, video/mp4', `the hint names the file (got ${document?.hint})`);
    })
);

cases.push(
    await runCase('an animated message yields its first frame, everything else yields nothing', async () => {
        let extractions = 0;
        const loader = createAnimationFrameLoader(async (video, mimeType) => {
            extractions += 1;
            expect(video.equals(VIDEO), 'the cached animation bytes are decoded');
            expect(mimeType === 'video/mp4', 'the cached mime is passed along');
            return { data: FRAME, mimeType: 'image/jpeg' };
        });

        const animationId = await seedMessage('anim-frame');
        await putCachedMedia({
            fileUniqueId: 'anim-frame',
            mime: 'video/mp4',
            kind: 'animation',
            data: VIDEO,
        });
        const frame = await loader(OFFLINE_CHAT_ID, animationId);
        expect(frame !== null && frame.kind === 'bytes' && frame.data.equals(FRAME), 'the frame comes back');
        expect(extractions === 1, 'the converter is called once');

        const documentId = await seedMessage('doc-frame');
        await putCachedMedia({
            fileUniqueId: 'doc-frame',
            mime: 'video/mp4',
            kind: 'document',
            data: VIDEO,
        });
        expect((await loader(OFFLINE_CHAT_ID, documentId)) === null, 'a plain document is not an animation');

        const cloudId = await seedMessage('anim-cloud');
        await putCachedMedia({
            fileUniqueId: 'anim-cloud',
            mime: 'video/mp4',
            kind: 'animation',
            fileUri: 'gs://bucket/large.mp4',
            sizeBytes: 30 * 1024 * 1024,
        });
        const cloud = await loader(OFFLINE_CHAT_ID, cloudId);
        expect(cloud !== null && cloud.kind === 'cloud', 'a GCS-only animation is reported as cloud');

        const broken = createAnimationFrameLoader(async () => null);
        const brokenId = await seedMessage('anim-broken');
        await putCachedMedia({
            fileUniqueId: 'anim-broken',
            mime: 'video/mp4',
            kind: 'animation',
            data: VIDEO,
        });
        expect((await broken(OFFLINE_CHAT_ID, brokenId)) === null, 'a failed decode is just "no picture"');
        expect(extractions === 1, 'nothing else reached the converter');
    })
);

cases.push(
    await runCase('the frame fills in only when a message has no picture of its own', async () => {
        const messageId = await seedMessage('anim-only');
        let calls = 0;
        const loader = async () => {
            calls += 1;
            return { kind: 'bytes' as const, data: FRAME };
        };
        const emptyLoad = async () => [];

        const entry: ContextIndexEntry = {
            number: 1,
            messageId,
            fromBot: false,
            images: [],
            imageCount: 0,
        };
        const withFrame = await loadContextImages(OFFLINE_CHAT_ID, entry, emptyLoad, loader);
        expect(
            withFrame.length === 1 && withFrame[0]?.kind === 'bytes' && withFrame[0].data.equals(FRAME),
            'the animation contributes one picture'
        );
        expect(calls === 1, 'the loader is consulted once');

        const withoutLoader = await loadContextImages(OFFLINE_CHAT_ID, entry, emptyLoad);
        expect(withoutLoader.length === 0, 'without the loader nothing is invented');

        const pictured: ContextIndexEntry = {
            ...entry,
            images: [{ origin: 'attachment', part: { type: 'image', imageData: FRAME.toString('base64') } }],
            imageCount: 1,
        };
        const own = await loadContextImages(OFFLINE_CHAT_ID, pictured, emptyLoad, loader);
        expect(own.length === 1 && calls === 1, 'a message with its own picture never triggers a decode');
    })
);

cases.push(
    await runCase('the backfill turns historical GIF rows into animations once', async () => {
        const legacyId = await seedMessage('legacy-gif', 'a file: animation.gif.mp4, video/mp4');
        await putCachedMedia({
            fileUniqueId: 'legacy-gif',
            mime: 'video/mp4',
            kind: 'document',
            data: VIDEO,
        });

        // The startup backfill already ran on the empty scratch database, so
        // clear its marker to exercise the statements themselves.
        await sequelize.query("DELETE FROM schema_migrations WHERE name = '20261027_animation_media_kind'");
        await backfillAnimationMediaKind();

        const row = await getMessage(OFFLINE_CHAT_ID, legacyId);
        expect(row?.mediaHint === 'an animation', `the hint is rewritten (got ${row?.mediaHint})`);
        const cached = await getCachedMedia('legacy-gif');
        expect(cached?.kind === 'animation', `the cache kind follows (got ${cached?.kind})`);

        // A second run must not change anything (and must not throw)
        await backfillAnimationMediaKind();
        const again = await getMessage(OFFLINE_CHAT_ID, legacyId);
        expect(again?.mediaHint === 'an animation', 'the rewrite is idempotent');
    })
);

await sequelize.close();

reportResults(cases);
