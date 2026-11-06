/**
 * Offline cases for context media dedupe: the same file arriving twice in one
 * context is attached once, and the second message says where it is.
 *
 * Run: npx tsx scripts/offline/media-dedupe.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import type { UnifiedContentPart, UnifiedMessage } from '../../src/ai/types.js';

const { dedupeContextMedia } = await import('../../src/reply/media-dedupe.js');
const { contextImagesOf } = await import('../../src/reply/context-images.js');

const base64Of = (text: string): string => Buffer.from(text).toString('base64');

const imagePart = (text: string): UnifiedContentPart => ({
    type: 'image',
    imageData: base64Of(text),
    mimeType: 'image/jpeg',
});

const videoPart = (text: string): UnifiedContentPart => ({
    type: 'media',
    mediaData: base64Of(text),
    mimeType: 'video/mp4',
    mediaKind: 'video',
});

const cloudPart = (uri: string): UnifiedContentPart => ({
    type: 'media',
    fileUri: uri,
    mimeType: 'video/mp4',
    mediaKind: 'video',
});

const textPart = (text: string): UnifiedContentPart => ({ type: 'text', text });

const turnOf = (
    messageId: number,
    parts: readonly UnifiedContentPart[],
    options: { readonly images?: 'attachment' } = {}
): {
    messageId: number;
    message: UnifiedMessage;
    images: ReturnType<typeof contextImagesOf>;
} => ({
    messageId,
    message: { role: 'user', content: [...parts] },
    images: options.images === undefined ? [] : contextImagesOf(parts, 'attachment'),
});

const CAPABILITIES = {
    supportsImageInput: true,
    supportsMediaInput: true,
    contextNumbers: new Map([
        [10, 1],
        [11, 2],
        [12, 3],
    ]),
};

const mediaPartsOf = (turn: { readonly message: UnifiedMessage } | undefined): readonly UnifiedContentPart[] =>
    turn === undefined ? [] : turn.message.content.filter((part) => part.type === 'image' || part.type === 'media');

const textOf = (turn: { readonly message: UnifiedMessage } | undefined): string =>
    turn === undefined
        ? ''
        : turn.message.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text ?? '')
              .join('\n');

const cases: CaseResult[] = [];

cases.push(
    await runCase('the same picture in two messages is attached once', async () => {
        const first = turnOf(10, [imagePart('same-bytes'), textPart('#1 张三: 看这个')], { images: 'attachment' });
        const second = turnOf(11, [imagePart('same-bytes'), textPart('#2 李四: 同一个')], { images: 'attachment' });
        const result = dedupeContextMedia([first, second], CAPABILITIES);

        expect(result.removed === 1, `one part is replaced (got ${result.removed})`);
        expect(mediaPartsOf(result.turns[0]).length === 1, 'the first message keeps its picture');
        expect(mediaPartsOf(result.turns[1]).length === 0, 'the second one does not');
        expect(
            textOf(result.turns[1]).includes('[system] the same media as #1'),
            `the note names the message that has it (got ${textOf(result.turns[1])})`
        );
        expect(result.turns[0]?.images.length === 1, 'the first message still offers its picture to tools');
        expect(result.turns[1]?.images.length === 0, 'the second offers none');
    })
);

cases.push(
    await runCase('different pictures are both kept', async () => {
        const first = turnOf(10, [imagePart('one')]);
        const second = turnOf(11, [imagePart('two')]);
        const result = dedupeContextMedia([first, second], CAPABILITIES);
        expect(result.removed === 0, 'nothing is dropped');
        expect(mediaPartsOf(result.turns[1]).length === 1, 'the second picture survives');
    })
);

cases.push(
    await runCase('a duplicate inside one message points at itself', async () => {
        // The message's own attachment and the same picture in its link preview
        const turn = turnOf(10, [imagePart('same-bytes'), textPart('#1'), imagePart('same-bytes')], {
            images: 'attachment',
        });
        const result = dedupeContextMedia([turn], CAPABILITIES);
        expect(result.removed === 1, 'the second copy is dropped');
        expect(
            textOf(result.turns[0]).includes('an earlier part of this message'),
            'the note says where it is without a number'
        );
        expect(result.turns[0]?.images.length === 1, 'the tool list keeps one picture');
    })
);

cases.push(
    await runCase('a video repeated in two messages is attached once', async () => {
        const first = turnOf(10, [videoPart('clip')]);
        const second = turnOf(11, [videoPart('clip')]);
        const result = dedupeContextMedia([first, second], CAPABILITIES);
        expect(result.removed === 1, 'the clip is not sent twice');
        expect(mediaPartsOf(result.turns[1]).length === 0, 'the second message has no clip');
    })
);

cases.push(
    await runCase('cloud media dedupes by uri and keeps distinct files', async () => {
        const first = turnOf(10, [cloudPart('gs://bucket/a.mp4')]);
        const second = turnOf(11, [cloudPart('gs://bucket/a.mp4')]);
        const third = turnOf(12, [cloudPart('gs://bucket/b.mp4')]);
        const result = dedupeContextMedia([first, second, third], CAPABILITIES);
        expect(result.removed === 1, 'the same gs:// reference is dropped once');
        expect(mediaPartsOf(result.turns[2]).length === 1, 'a different file is kept');
    })
);

cases.push(
    await runCase('a text-only model pays for nothing and reads no notes', async () => {
        const first = turnOf(10, [imagePart('same-bytes')]);
        const second = turnOf(11, [imagePart('same-bytes')]);
        const result = dedupeContextMedia([first, second], {
            ...CAPABILITIES,
            supportsImageInput: false,
            supportsMediaInput: false,
        });
        expect(result.removed === 0, 'nothing is considered');
        expect(mediaPartsOf(result.turns[1]).length === 1, 'the parts stay where they are');
        expect(!textOf(result.turns[1]).includes('[system]'), 'no note is added');
    })
);

cases.push(
    await runCase('a custom emoji atlas is never replaced by a pointer', async () => {
        const atlas = (): UnifiedContentPart => ({
            type: 'image',
            imageData: base64Of('atlas'),
            mimeType: 'image/png',
            mediaKind: 'custom_emoji_atlas',
        });
        const first = turnOf(10, [atlas(), imagePart('primary')]);
        const second = turnOf(11, [atlas()]);
        const result = dedupeContextMedia([first, second], CAPABILITIES);
        expect(result.removed === 0, 'the atlas is not conversation media');
        expect(mediaPartsOf(result.turns[1]).length === 1, 'the second message keeps its atlas');
    })
);

cases.push(
    await runCase('text parts are never touched', async () => {
        const first = turnOf(10, [textPart('同样的文字'), imagePart('a')]);
        const second = turnOf(11, [textPart('同样的文字'), imagePart('b')]);
        const result = dedupeContextMedia([first, second], CAPABILITIES);
        expect(result.removed === 0, 'identical text is not media');
        expect(textOf(result.turns[1]) === '同样的文字', 'the text is left alone');
    })
);

reportResults(cases);
