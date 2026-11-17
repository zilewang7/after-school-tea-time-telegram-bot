/**
 * t.me message-link snapshot dedupe (design 2026-1118-0149, section 3.4):
 * the same canonical link planned for several messages of one context gets one
 * full snapshot and a pointer line per repetition; the repetitions do not
 * consume the per-context block budget.
 *
 * Run: npx tsx scripts/offline/tg-message-link-dedupe.mts
 */
import { OFFLINE_CHAT_ID, expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';

delete process.env.LUOXU_PREVIEW_URL;
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
process.env.BOT_USER_ID = '7777';
delete process.env.ALLOWED_CHAT_IDS;

await setupOfflineDb();
const { planTgMessageLinkPreviews, getTgMessageLinkPreviewParts } = await import(
    '../../src/services/tg-message-link-service.js'
);
const { TgMessageLinkCache: CacheModel } = await import('../../src/db/tgMessageLinkCacheDTO.js');

const EXTERNAL_CHAT = -1001234567890;
const URL_A = 'https://t.me/c/1234567890/5000';

const seedSnapshot = async (url: string, targetId: number, text: string): Promise<void> => {
    await CacheModel.upsert({
        url,
        status: 'ready',
        source: 'db',
        chatId: EXTERNAL_CHAT,
        messageId: targetId,
        chatTitle: '别的群',
        senderName: '远处的人',
        messageDate: new Date('2026-11-01T00:00:00Z'),
        text,
        replyToId: null,
        contextItems: null,
        mediaItems: null,
        unavailableReason: null,
        lastUsedAt: new Date(),
    });
};

const results: CaseResult[] = [];

results.push(
    await runCase('one canonical link in two messages: one snapshot, one pointer, no extra budget', async () => {
        await seedSnapshot(URL_A, 5000, '被链接的正文');
        const plan = planTgMessageLinkPreviews(OFFLINE_CHAT_ID, [
            { messageId: 1, text: `看这条 ${URL_A}` },
            { messageId: 2, text: `再贴一次 ${URL_A}` },
        ]);
        const newest = plan.get(2)?.flat();
        const oldest = plan.get(1)?.flat();
        expect(plan.get(1)?.length === 1 && plan.get(2)?.length === 1, 'both messages keep one entry');
        expect(newest?.[0]?.duplicateOfMessageId === undefined, 'the newest occurrence pays for the snapshot');
        expect(oldest?.[0]?.duplicateOfMessageId === 2, 'the older one points at the message that paid');

        const contextNumbers = new Map([
            [1, 1],
            [2, 2],
        ]);
        const full = await getTgMessageLinkPreviewParts(OFFLINE_CHAT_ID, plan.get(2), contextNumbers);
        const pointer = await getTgMessageLinkPreviewParts(OFFLINE_CHAT_ID, plan.get(1), contextNumbers);
        const fullText = full.filter((part) => part.type === 'text').map((part) => (part.type === 'text' ? part.text ?? '' : '')).join('\n');
        const pointerText = pointer.filter((part) => part.type === 'text').map((part) => (part.type === 'text' ? part.text ?? '' : '')).join('\n');
        expect(fullText.includes('被链接的正文'), `the full block reads the snapshot (${fullText})`);
        expect(pointerText.includes('已在 #2 注入'), `the pointer names the block's number (${pointerText})`);
        expect(pointerText.includes('不重复'), 'the pointer says the snapshot is not repeated');
    })
);

results.push(
    await runCase('repetitions do not consume the 4-block budget', async () => {
        await seedSnapshot(URL_A, 5000, '被链接的正文');
        const distinct = [
            'https://t.me/c/1234567890/7001',
            'https://t.me/c/1234567890/7002',
            'https://t.me/c/1234567890/7003',
        ] as const;
        for (const [index, url] of distinct.entries()) {
            await seedSnapshot(url, 7001 + index, `另一条 ${index}`);
        }
        // Newest first: A is repeated three times before three distinct links
        // exhaust the 4-block budget.
        const plan = planTgMessageLinkPreviews(OFFLINE_CHAT_ID, [
            { messageId: 1, text: distinct[0] },
            { messageId: 2, text: distinct[1] },
            { messageId: 3, text: distinct[2] },
            { messageId: 4, text: URL_A },
            { messageId: 5, text: URL_A },
            { messageId: 6, text: URL_A },
        ]);
        const entries = [...plan.values()].flat();
        const fullBlocks = entries.filter((entry) => entry.duplicateOfMessageId === undefined);
        const pointers = entries.filter((entry) => entry.duplicateOfMessageId !== undefined);
        expect(fullBlocks.length === 4, `four distinct links keep the budget (got ${fullBlocks.length})`);
        expect(pointers.length === 2, `both repetitions become pointers (got ${pointers.length})`);
        expect(
            pointers.every((entry) => entry.duplicateOfMessageId === 6),
            'both pointers name the message that paid for the snapshot'
        );
    })
);

results.push(
    await runCase('a plan with only distinct links is unchanged', async () => {
        const plan = planTgMessageLinkPreviews(OFFLINE_CHAT_ID, [
            { messageId: 10, text: 'https://t.me/c/1234567890/9001' },
            { messageId: 11, text: 'https://t.me/c/1234567890/9002' },
        ]);
        const entries = [...plan.values()].flat();
        expect(entries.length === 2, 'both links are planned');
        expect(entries.every((entry) => entry.duplicateOfMessageId === undefined), 'no pointer entries');
        expect(entries.filter((entry) => entry.withMedia).length === 2, 'both keep their media');
    })
);

await reportResults(results);
