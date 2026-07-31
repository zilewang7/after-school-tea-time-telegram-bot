/**
 * Offline regression cases (no containers, no network).
 *
 * Run: pnpm test:offline
 *
 * Covers the invariants that the e2e suite cannot pin down deterministically:
 * reply-tree assembly (which used to lose messages to a write race) and the
 * per-key lock that serializes read-modify-write on `replies`.
 */
import {
    OFFLINE_CHAT_ID,
    expect,
    reportResults,
    runCase,
    setupOfflineDb,
    takeMessageId,
    type CaseResult,
    type OfflineDb,
} from './harness.mts';
import { createKeyedLock } from '../../src/shared/keyed-lock.js';
import type { User } from 'grammy/types';
import type { ResponseState } from '../../src/ai/types.js';

// Set before importing the gate: it snapshots the env at module load
process.env.IGNORED_SENDER_IDS = '424242';
const { shouldIgnoreSender } = await import('../../src/config/sender-gate.js');

const db: OfflineDb = await setupOfflineDb();
const { Message, queries } = db;

interface SeedOptions {
    messageId?: number;
    replyToId?: number | null;
    /** Stored the way the app stores it: JSON text holding a JSON string */
    replies?: number[];
    text?: string | null;
    userName?: string;
    fileUniqueId?: string | null;
    fromBotSelf?: boolean;
    ocrText?: string | null;
}

/** Insert one message row directly, bypassing the Telegram-facing save path */
const seedMessage = async (options: SeedOptions = {}): Promise<number> => {
    const messageId = options.messageId ?? takeMessageId();
    await Message.create({
        chatId: OFFLINE_CHAT_ID,
        messageId,
        fromBotSelf: options.fromBotSelf ?? false,
        date: new Date(messageId * 1000),
        userName: options.userName ?? 'tester',
        text: options.text ?? `message ${messageId}`,
        quoteText: null,
        file: null,
        fileMime: null,
        fileUniqueId: options.fileUniqueId ?? null,
        replyToId: options.replyToId ?? null,
        replies: JSON.stringify(JSON.stringify(options.replies ?? [])),
        modelParts: null,
        mediaHint: null,
        forwardOrigin: null,
        ocrText: options.ocrText ?? null,
    });
    return messageId;
};

const idsOf = (messages: Array<{ messageId: number }>): number[] =>
    messages.map((message) => message.messageId);

const asUser = (fields: { id: number; is_bot: boolean; username?: string }): User => ({
    first_name: fields.username ?? `user-${fields.id}`,
    ...fields,
});

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: 'sender gate silences bots but not people',
        body: async () => {
            expect(
                !shouldIgnoreSender(asUser({ id: 111, is_bot: false })),
                'a normal user is answered'
            );
            expect(
                shouldIgnoreSender(asUser({ id: 987598712, is_bot: true, username: 'butanediol_bot' })),
                'another bot is ignored'
            );
            expect(
                !shouldIgnoreSender(asUser({ id: 1087968824, is_bot: true, username: 'GroupAnonymousBot' })),
                'an anonymous admin is still answered'
            );
            expect(
                shouldIgnoreSender(asUser({ id: 424242, is_bot: false })),
                'IGNORED_SENDER_IDS covers userbots that report is_bot: false'
            );
            expect(!shouldIgnoreSender(undefined), 'an update without a sender is left alone');
        },
    },
    {
        name: 'parseStoredReplyIds accepts every stored shape',
        body: async () => {
            const { parseStoredReplyIds } = queries;
            expect(
                JSON.stringify(parseStoredReplyIds(JSON.stringify('[1,2]'))) === '[1,2]',
                'double-encoded JSON string parses'
            );
            expect(JSON.stringify(parseStoredReplyIds('[3,4]')) === '[3,4]', 'plain array parses');
            expect(parseStoredReplyIds(null).length === 0, 'null yields empty');
            expect(parseStoredReplyIds('not json').length === 0, 'garbage yields empty');
            expect(parseStoredReplyIds('"[]"').length === 0, 'empty stored array yields empty');
        },
    },
    {
        // Regression: the parent's `replies` used to be appended to by an
        // unawaited read-modify-write, which dropped the child entirely when the
        // parent row did not exist yet (a reply arriving mid-stream).
        name: 'a reply is in the tree even when the parent records nothing',
        body: async () => {
            const parent = await seedMessage({ text: 'question' });
            const child = await seedMessage({ replyToId: parent, text: 'answer' });
            // parent.replies stays '[]' on purpose — nothing wrote back to it

            const history = await queries.getRepliesHistory(OFFLINE_CHAT_ID, child, {
                excludeSelf: false,
            });
            expect(
                JSON.stringify(idsOf(history)) === JSON.stringify([parent, child]),
                `tree is [parent, child] (got ${JSON.stringify(idsOf(history))})`
            );
        },
    },
    {
        // Regression: /chat's merge and the append raced, and the loser's ids
        // vanished. Reply children now come from replyToId, /chat additions from
        // `replies`; the union must contain both, in chronological order.
        name: 'reply children and /chat additions are merged chronologically',
        body: async () => {
            const target = await seedMessage({ text: 'target' });
            const bystanderA = await seedMessage({ text: 'bystander with a picture' });
            const bystanderB = await seedMessage({ text: 'another bystander' });
            // /chat attaches the bystanders (they reply to nothing)
            await Message.update(
                { replies: JSON.stringify(JSON.stringify([bystanderA, bystanderB])) },
                { where: { chatId: OFFLINE_CHAT_ID, messageId: target } }
            );
            const command = await seedMessage({ replyToId: target, text: ' ' });

            const childIds = await queries.getChildMessageIds(OFFLINE_CHAT_ID, {
                messageId: target,
                replies: JSON.stringify(JSON.stringify([bystanderA, bystanderB])),
            });
            expect(
                JSON.stringify(childIds) === JSON.stringify([bystanderA, bystanderB, command]),
                `children are the bystanders plus the command (got ${JSON.stringify(childIds)})`
            );

            const history = await queries.getRepliesHistory(OFFLINE_CHAT_ID, command, {
                excludeSelf: false,
            });
            expect(
                JSON.stringify(idsOf(history)) ===
                    JSON.stringify([target, bystanderA, bystanderB, command]),
                `full tree keeps everything (got ${JSON.stringify(idsOf(history))})`
            );
        },
    },
    {
        // /chat can attach an ancestor to its own descendant; without a visited
        // set the reverse lookup would recurse until the stack blew up.
        name: 'a cycle introduced by /chat does not hang the tree walk',
        body: async () => {
            const root = await seedMessage({ text: 'root' });
            const child = await seedMessage({ replyToId: root, text: 'child' });
            // Attach the root back onto its own child
            await Message.update(
                { replies: JSON.stringify(JSON.stringify([root])) },
                { where: { chatId: OFFLINE_CHAT_ID, messageId: child } }
            );

            const history = await queries.getRepliesHistory(OFFLINE_CHAT_ID, child, {
                excludeSelf: false,
            });
            expect(
                JSON.stringify(idsOf(history)) === JSON.stringify([root, child]),
                `walk terminates with each message once (got ${JSON.stringify(idsOf(history))})`
            );
        },
    },
    {
        // Media-group sub-images are filtered out of the tree, but their media
        // must still be attached to the group's first message.
        name: "media-group sub-images are found without the parent's replies",
        body: async () => {
            const firstUniqueId = `offline-first-${takeMessageId()}`;
            const subUniqueId = `offline-sub-${takeMessageId()}`;
            await db.putCachedMedia({
                fileUniqueId: firstUniqueId,
                data: Buffer.from('first-image-bytes'),
                sizeBytes: 17,
                mime: 'image/jpeg',
                kind: 'photo',
            });
            await db.putCachedMedia({
                fileUniqueId: subUniqueId,
                data: Buffer.from('sub-image-bytes'),
                sizeBytes: 15,
                mime: 'image/jpeg',
                kind: 'photo',
            });

            const first = await seedMessage({ text: 'group caption', fileUniqueId: firstUniqueId });
            await seedMessage({
                replyToId: first,
                text: `sub image of [${first}]`,
                fileUniqueId: subUniqueId,
            });

            const parts = await queries.getFileContentsOfMessage(OFFLINE_CHAT_ID, first);
            expect(parts.length === 2, `both images are attached (got ${parts.length})`);
            expect(
                parts.every((part) => part.type === 'image'),
                'both parts are images'
            );

            const history = await queries.getRepliesHistory(OFFLINE_CHAT_ID, first, {
                excludeSelf: false,
            });
            expect(
                JSON.stringify(idsOf(history)) === JSON.stringify([first]),
                `the sub-image stays out of the tree (got ${JSON.stringify(idsOf(history))})`
            );
        },
    },
    {
        // The model sometimes copies the `[#N]` label its own history carries,
        // despite the system prompt. It must never reach the group or the DB.
        name: 'a leaked [#N] label is stripped from the reply',
        body: async () => {
            const { createContextLabelStripper, stripContextLabel } = await import(
                '../../src/reply/context-label.js'
            );

            /** Feed one reply through a fresh stripper, chunk by chunk */
            const streamed = (chunks: string[]): string => {
                const strip = createContextLabelStripper();
                return chunks.map((chunk) => strip(chunk)).join('');
            };

            expect(streamed(['[#2]\n你好呀']) === '你好呀', 'label in one chunk is removed');
            expect(
                streamed(['[', '#12]', '\n你好呀']) === '你好呀',
                'label split across chunks is removed'
            );
            expect(
                streamed(['[#2]\n\n  你好呀']) === '你好呀',
                'the blank lines after the label go too'
            );
            expect(
                streamed(['[#3] 说得对', '，我同意']) === '[#3] 说得对，我同意',
                'a label used mid-sentence is a real reference and stays'
            );
            expect(
                streamed(['你', '好', '呀']) === '你好呀',
                'an ordinary reply passes through untouched'
            );
            expect(
                streamed(['[笑] 哈哈']) === '[笑] 哈哈',
                'other bracketed openings are left alone'
            );
            expect(
                streamed(['#2 说得对']) === '#2 说得对',
                'a bare context reference is not a label'
            );
            expect(
                stripContextLabel('[#7]\n完整文本') === '完整文本',
                'the non-streaming path strips it as well'
            );
        },
    },
    {
        // Guards the wiring, not just the stripper: both buffers are fed from
        // processChunk, and the one that ends up in the DB is fullText.
        name: 'the stream processor applies the label stripping',
        body: async () => {
            const { processChunk } = await import('../../src/reply/response-handler.js');
            const { createContextLabelStripper } = await import('../../src/reply/context-label.js');

            const strip = createContextLabelStripper();
            let state: ResponseState = {
                textBuffer: '',
                thinkingBuffer: '',
                fullText: '',
                fullThinking: '',
                thinkingTruncatedChars: 0,
                images: [],
                groundingData: [],
                agentStats: undefined,
                modelParts: undefined,
                rawResponse: undefined,
                isDone: false,
            };
            for (const content of ['[#4]', '\n梓喵的回答', '就是这样']) {
                state = processChunk({ type: 'text', content }, state, strip);
            }
            expect(state.fullText === '梓喵的回答就是这样', `fullText is clean (got ${JSON.stringify(state.fullText)})`);
            expect(state.textBuffer === '梓喵的回答就是这样', 'the display buffer is clean too');

            // Platforms that report a final text replace the buffers wholesale,
            // bypassing the streaming stripper
            const finished = processChunk(
                { type: 'done', rawResponse: { output_text: '[#4]\n梓喵的回答就是这样' } },
                state,
                strip
            );
            expect(
                finished.fullText === '梓喵的回答就是这样',
                `a replacement final text is cleaned as well (got ${JSON.stringify(finished.fullText)})`
            );
        },
    },
    {
        // A model that cannot see images gets the OCR text instead; one that can
        // must not get it, or it would pay for the same content twice.
        name: 'OCR text is offered only to models that cannot see images',
        body: async () => {
            const { buildContext } = await import('../../src/reply/context-builder.js');

            const uniqueId = `offline-ocr-${takeMessageId()}`;
            await db.putCachedMedia({
                fileUniqueId: uniqueId,
                data: Buffer.from('screenshot-bytes'),
                sizeBytes: 16,
                mime: 'image/png',
                kind: 'photo',
            });
            const messageId = await seedMessage({
                text: '这图里写了什么',
                fileUniqueId: uniqueId,
                ocrText: 'OCR-TEST-XYZ789',
            });
            const row = await Message.findOne({
                where: { chatId: OFFLINE_CHAT_ID, messageId },
            });
            if (!row) throw new Error('seeded message not found');

            const capabilities = {
                supportsImageInput: false,
                supportsImageOutput: false,
                supportsSystemPrompt: true,
                requiresMessageMerge: false,
                supportsThinking: false,
                supportsGrounding: false,
                supportsMediaInput: false,
            };

            const blind = await buildContext(row, capabilities);
            const blindTexts = blind.flatMap((message) =>
                message.content.filter((part) => part.type === 'text').map((part) => part.text ?? '')
            );
            expect(
                blind.every((message) => message.content.every((part) => part.type === 'text')),
                'the image itself is filtered out for a text-only model'
            );
            expect(
                blindTexts.some((text) => text.includes('OCR-TEST-XYZ789')),
                'the recognized text reaches the model'
            );
            expect(
                blindTexts.some((text) => text.includes('可能有错字')),
                'it is labelled as machine-recognized'
            );

            const seeing = await buildContext(row, {
                ...capabilities,
                supportsImageInput: true,
            });
            const seeingParts = seeing.flatMap((message) => message.content);
            expect(
                seeingParts.some((part) => part.type === 'image'),
                'a vision model still gets the image'
            );
            expect(
                !seeingParts.some((part) => (part.text ?? '').includes('OCR-TEST-XYZ789')),
                'and is not sent the OCR text on top of it'
            );
        },
    },
    {
        // The lock is what keeps two /chat merges on the same target from
        // clobbering each other the way the old append did.
        name: 'keyed lock serializes read-modify-write on one key',
        body: async () => {
            const lock = createKeyedLock();
            const store = new Map<string, number[]>([
                ['a', []],
                ['b', []],
            ]);

            // Without the lock this read-await-write loses all but one update
            const merge = (key: string, value: number): Promise<void> =>
                lock.runExclusive(key, async () => {
                    const current = [...(store.get(key) ?? [])];
                    await new Promise((resolve) => setTimeout(resolve, 5));
                    store.set(key, [...current, value]);
                });

            await Promise.all([
                merge('a', 1),
                merge('a', 2),
                merge('a', 3),
                merge('b', 9),
            ]);

            expect(
                JSON.stringify(store.get('a')) === JSON.stringify([1, 2, 3]),
                `all three updates survived (got ${JSON.stringify(store.get('a'))})`
            );
            expect(
                JSON.stringify(store.get('b')) === JSON.stringify([9]),
                'a different key is unaffected'
            );

            // A rejecting task must not poison later holders of the same key
            const failure = lock
                .runExclusive('a', async () => {
                    throw new Error('boom');
                })
                .catch((error: unknown) => (error instanceof Error ? error.message : 'unknown'));
            expect((await failure) === 'boom', 'the failure reaches its own caller');
            await merge('a', 4);
            expect(
                JSON.stringify(store.get('a')) === JSON.stringify([1, 2, 3, 4]),
                'the key still works after a rejection'
            );
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
