/**
 * Offline cases for the data-level redaction of public share content (design
 * 2026-1110-1733): the ids inside Telegram links never reach a share page or
 * its JSON API — they are replaced with `[data-deletion]` — while the rest of
 * the text, the link shape and public t.me addresses stay untouched.
 *
 * Run: npx tsx scripts/offline/share-redaction.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import type { ShareContent } from '../../src/panel/share/share-content.js';

const { DELETION_PLACEHOLDER, redactSensitiveIds, redactShareContent } = await import(
    '../../src/panel/share/share-redaction.js'
);

const cases: CaseResult[] = [];

cases.push(
    await runCase('a user mention id is replaced, the link stays shaped the same', () => {
        expect(DELETION_PLACEHOLDER === '[data-deletion]', 'the literal placeholder');
        expect(
            redactSensitiveIds('回 [黑猫](tg://user?id=841282418) 一下') ===
                '回 [黑猫](tg://user?id=[data-deletion]) 一下',
            `a markdown mention (got ${redactSensitiveIds('回 [黑猫](tg://user?id=841282418) 一下')})`
        );
    })
);

cases.push(
    await runCase('tg:// query ids are replaced one parameter at a time', () => {
        expect(
            redactSensitiveIds('tg://user?id=603421700&lang=zh') === 'tg://user?id=[data-deletion]&lang=zh',
            'other parameters survive'
        );
        expect(
            redactSensitiveIds('tg://openmessage?chat_id=-1001415974153&message_id=1118043') ===
                'tg://openmessage?chat_id=[data-deletion]&message_id=1118043',
            'the message id means nothing without its chat, so it stays'
        );
    })
);

cases.push(
    await runCase('the internal id of a t.me/c link is replaced, the message id stays', () => {
        expect(
            redactSensitiveIds('看 https://t.me/c/1415974153/1118043 这条') ===
                '看 https://t.me/c/[data-deletion]/1118043 这条',
            'numbered internal link'
        );
        expect(redactSensitiveIds('t.me/c/1234567/89') === 't.me/c/[data-deletion]/89', 'bare internal link');
        expect(
            redactSensitiveIds('https://telegram.me/c/1234567/89') === 'https://telegram.me/c/[data-deletion]/89',
            'the telegram.me alias'
        );
    })
);

cases.push(
    await runCase('invite hashes are replace, public t.me addresses are not', () => {
        expect(redactSensitiveIds('https://t.me/+AbCdEfGhIj') === 'https://t.me/+[data-deletion]', 't.me/+ hash');
        expect(
            redactSensitiveIds('https://t.me/joinchat/AbCdEfGhIj') === 'https://t.me/joinchat/[data-deletion]',
            'joinchat hash'
        );
        expect(
            redactSensitiveIds('https://t.me/AfterSchoolTeatimeBot/panel?startapp=sabc') ===
                'https://t.me/AfterSchoolTeatimeBot/panel?startapp=sabc',
            'a public bot link is not sensitive'
        );
        expect(redactSensitiveIds('https://t.me/somechannel/123') === 'https://t.me/somechannel/123', 'a public channel');
        expect(redactSensitiveIds('没有链接的正文保持原样') === '没有链接的正文保持原样', 'plain text');
    })
);

cases.push(
    await runCase('redaction is idempotent', () => {
        const once = redactSensitiveIds('tg://user?id=42 和 https://t.me/c/100/2 和 https://t.me/+AbCdEf');
        expect(redactSensitiveIds(once) === once, `a second pass changes nothing (got ${once})`);
    })
);

cases.push(
    await runCase('a conversation share is redacted in every field a page can show', () => {
        const content: ShareContent = {
            kind: 'conversation',
            chatId: -1001415974153,
            chatTitle: '群 https://t.me/+GroupHash',
            rootId: 1,
            preview: { chatTitle: null, createdAt: '2026-11-10T00:00:00.000Z', text: 'preview' },
            bubbles: [
                {
                    kind: 'user',
                    messageId: 1,
                    createdAt: '2026-11-10T00:00:00.000Z',
                    authorName: '黑猫',
                    text: '[某人](tg://user?id=841282418) 看 https://t.me/c/1415974153/1',
                    quote: 'tg://user?id=42',
                    previewText: 'URL: https://t.me/c/1415974153/2',
                    replyTo: { messageId: 0, authorName: '某人', snippet: 'tg://user?id=7', mediaHint: null },
                    mediaHint: null,
                    media: null,
                    previewMedia: [],
                },
                {
                    kind: 'bot',
                    messageId: 2,
                    createdAt: '2026-11-10T00:00:01.000Z',
                    text: '回 [黑猫](tg://user?id=603421700)',
                    widget: { html: '<div>x</div>', caption: 'tg://user?id=9', imageBase64: null },
                    replyTo: { messageId: 1, authorName: '黑猫', snippet: null, mediaHint: 'a picture' },
                    media: null,
                },
            ],
        };
        const redacted = redactShareContent(content);
        // chatId is a documented public field of the view, so keep it out of the substring scan
        const serialized = JSON.stringify({ ...redacted, chatId: 0 });
        expect(!serialized.includes('841282418'), 'no mention id in the JSON');
        expect(!serialized.includes('1415974153'), 'no internal chat id in the JSON');
        expect(!serialized.includes('603421700') && !serialized.includes('id=42'), 'no ids in quotes or reply snippets');
        expect(!serialized.includes('GroupHash'), 'no invite hash in the title');
        expect(serialized.includes('[data-deletion]'), 'the placeholder is what the page shows');
        expect(serialized.includes('preview'), 'the server-side preview snapshot is untouched');
        expect((redacted as { bubbles: { kind: string }[] }).bubbles.length === 2, 'bubbles survive');
    })
);

cases.push(
    await runCase('a reply share text and caption are redacted too', () => {
        const content: ShareContent = {
            kind: 'reply',
            chatId: -1001415974153,
            chatTitle: null,
            firstMessageId: 1,
            versionId: 1,
            versionNumber: 1,
            createdAt: '2026-11-10T00:00:00.000Z',
            model: 'gemini-4-argon',
            text: '见 https://t.me/c/1415974153/2',
            widget: { html: '<div>x</div>', caption: 'tg://user?id=42', imageBase64: null },
            media: null,
            preview: { chatTitle: null, createdAt: '2026-11-10T00:00:00.000Z', text: 'preview' },
        };
        const redacted = redactShareContent(content);
        expect(redacted.kind === 'reply', 'still a reply share');
        const serialized = JSON.stringify({ ...redacted, chatId: 0 });
        expect(!serialized.includes('1415974153') && !serialized.includes('id=42'), 'text and caption redacted');
        expect(serialized.includes('[data-deletion]'), 'the placeholder is present');
    })
);

reportResults(cases);
