/**
 * Message kinds: the Telegram message types that carry no ordinary text
 * (harness issue #16; design docs/2026-1124-1411-… §3.2, §4.1, §7.1):
 *
 * - autoSave stores a machine token (`messageKind`) and an English detail
 *   (`messageDetail`) for content types (poll/dice/location/contact/…) and
 *   group service events (member left/joined, title, pinned, forum, …);
 * - the context builder renders them as header annotations instead of the old
 *   bare `#N 用户名` + `<<EOF` empty block;
 * - rows stored before the columns existed, and types this build cannot read,
 *   get one explicit `[unsupported …]` annotation;
 * - text/media rows, `/chat` summons without words, media groups, rich
 *   messages, edits and assistant turns keep their previous behaviour.
 *
 * Run: npx tsx scripts/offline/message-kinds.mts
 */
import type { Chat, Message, Update, User } from 'grammy/types';
import type { ModelCapabilities, UnifiedMessage } from '../../src/ai/types.js';
import {
    OFFLINE_CHAT_ID,
    expect,
    reportResults,
    runCase,
    setupOfflineDb,
    takeMessageId,
    type CaseResult,
} from './harness.mts';
import { createFakeBot, quietly, waitUntil } from './fake-telegram.mts';

// Read per call by autoSave; set before the first src import
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
process.env.BOT_USER_ID = '7777';
delete process.env.ALLOWED_CHAT_IDS;
delete process.env.LUOXU_PREVIEW_URL;

const db = await setupOfflineDb();
const { Message: MessageRow } = db;
const { autoSave, autoUpdate } = await import('../../src/db/autoSave.js');
const { buildContext, describeMessageAnnotations } = await import('../../src/reply/context-builder.js');
const { assembleContextMessages } = await import('../../src/reply/context-assembly.js');
const { sanitizeMessageDetail } = await import('../../src/db/message-kind.js');
const { isAsyncFileSavePending } = await import('../../src/state.js');
const { runSchemaMigrations } = await import('../../src/db/schema-migrations.js');
const { sequelize } = await import('../../src/db/config.js');
const { QueryTypes } = await import('@sequelize/core');

const USER_ID = 42;
const BOT_USER_ID = 7777;
const ADMIN = 555;
const SENT_AT = 1_800_000_000;

const VISION: ModelCapabilities = {
    supportsImageInput: true,
    supportsImageOutput: false,
    supportsSystemPrompt: true,
    requiresMessageMerge: false,
    supportsThinking: false,
    supportsMediaInput: false,
};
const TEXT_ONLY: ModelCapabilities = { ...VISION, supportsImageInput: false };

const CHAT: Chat.SupergroupChat = { id: OFFLINE_CHAT_ID, type: 'supergroup', title: '测试群' };

type IncomingMessage = NonNullable<Update['message']>;
type ReplyTarget = NonNullable<Message['reply_to_message']>;

const { bot } = createFakeBot();
autoSave(bot);
autoUpdate(bot);

let nextUpdateId = 100;

const sender = (id: number, firstName: string, lastName?: string): User => ({
    id,
    is_bot: false,
    first_name: firstName,
    ...(lastName === undefined ? {} : { last_name: lastName }),
});

const messageOf = (messageId: number, from: User, patch: Partial<IncomingMessage> = {}): IncomingMessage => ({
    message_id: messageId,
    date: SENT_AT,
    chat: CHAT,
    from,
    ...patch,
});

const messageUpdate = (messageId: number, from: User, patch: Partial<IncomingMessage> = {}): Update => ({
    update_id: (nextUpdateId += 1),
    message: messageOf(messageId, from, patch),
});

const replyTargetOf = (messageId: number): ReplyTarget => ({
    message_id: messageId,
    date: SENT_AT - 60,
    chat: CHAT,
    reply_to_message: undefined,
});

const editedUpdate = (messageId: number, from: User, patch: Partial<IncomingMessage> = {}): Update => ({
    update_id: (nextUpdateId += 1),
    edited_message: { ...messageOf(messageId, from, patch), edit_date: SENT_AT + 60 },
});

/**
 * An update carrying a field @grammyjs/types 5.0.0 does not declare (widget,
 * ton_wallet_transfer, a future type). The JSON round-trip is the only way to
 * attach an unknown field without a cast, which the dependency guard counts.
 */
const untypedMessageUpdate = (messageId: number, from: User, fields: Record<string, unknown>): Update =>
    JSON.parse(JSON.stringify({
        update_id: (nextUpdateId += 1),
        message: { ...messageOf(messageId, from), ...fields },
    }));

const photoSize = (uniqueId: string) => ({
    file_id: `file-${uniqueId}`,
    file_unique_id: uniqueId,
    width: 90,
    height: 90,
    file_size: 1024,
});

/** Feed one update into the middleware chain */
const ingest = async (update: Update): Promise<void> => {
    await quietly(() => bot.handleUpdate(update));
};

/** Wait until the async media acquisition of a message has given up */
const waitForMedia = async (messageId: number): Promise<void> => {
    await quietly(() =>
        waitUntil(
            `media of ${messageId} to settle`,
            () => !isAsyncFileSavePending(OFFLINE_CHAT_ID, messageId)
        )
    );
};

const rowOf = async (messageId: number) => {
    const row = await MessageRow.findOne({ where: { chatId: OFFLINE_CHAT_ID, messageId } });
    if (row === null) throw new Error(`message ${messageId} is not stored`);
    return row;
};

/** Build the model context of one stored message */
const build = async (
    messageId: number,
    options: { capabilities?: ModelCapabilities; excludeMessageIds?: number[] } = {}
): Promise<UnifiedMessage[]> => {
    const row = await rowOf(messageId);
    const { messages } = await buildContext(row, {
        capabilities: options.capabilities ?? VISION,
        model: 'gemini-3.8-flash',
        ...(options.excludeMessageIds === undefined
            ? {}
            : { excludeMessageIds: options.excludeMessageIds }),
    });
    return messages;
};

/** The message block (header + body + `<<EOF`) of a turn, without the runtime tail */
const blockOf = (message: UnifiedMessage | undefined): string => {
    const first = message?.content[0];
    return first !== undefined && first.type === 'text' ? first.text ?? '' : '';
};

const textsOf = (message: UnifiedMessage): string[] =>
    message.content.flatMap((part) => (part.type === 'text' ? [part.text ?? ''] : []));

const renderOf = (messages: readonly UnifiedMessage[]): string =>
    messages.map((message) => textsOf(message).join('')).join('\n');

interface SeedOptions {
    text?: string | null;
    fromBot?: boolean;
    replyToId?: number | null;
    chatCommand?: string | null;
    mediaHint?: string | null;
    fileUniqueId?: string | null;
    fileMime?: string | null;
    messageKind?: string | null;
    messageDetail?: string | null;
    deletedAt?: Date | null;
}

const seedMessage = async (options: SeedOptions = {}): Promise<number> => {
    const messageId = takeMessageId();
    await MessageRow.create({
        chatId: OFFLINE_CHAT_ID,
        messageId,
        fromBotSelf: options.fromBot === true,
        userId: options.fromBot === true ? BOT_USER_ID : USER_ID,
        date: new Date(messageId * 1000),
        userName: options.fromBot === true ? 'Bot' : 'tester',
        text: 'text' in options ? options.text ?? null : `message ${messageId}`,
        quoteText: null,
        file: null,
        fileMime: options.fileMime ?? null,
        fileUniqueId: options.fileUniqueId ?? null,
        replyToId: options.replyToId ?? null,
        chatCommand: options.chatCommand ?? null,
        modelParts: null,
        mediaHint: options.mediaHint ?? null,
        forwardOrigin: null,
        forwardFromId: null,
        viaBot: null,
        ocrText: null,
        messageKind: options.messageKind ?? null,
        messageDetail: options.messageDetail ?? null,
        deletedAt: options.deletedAt ?? null,
    });
    return messageId;
};

const results: CaseResult[] = [];

// Handed from one case to a later one (the panel and reply cases read them)
let removedServiceId = 0;
let removedByAdminPollId = 0;

// ---- 1. The issue's own case: an admin removes a bot from the group ----

results.push(
    await runCase('a removed member is stored and rendered as a service event', async () => {
        const messageId = takeMessageId();
        removedServiceId = messageId;
        await ingest(messageUpdate(messageId, sender(ADMIN, 'K-OFF'), {
            left_chat_member: sender(8_917_382_004, 'Bot helps bot'),
        }));

        const row = await rowOf(messageId);
        expect(row.messageKind === 'service', `the kind is service (${row.messageKind})`);
        expect(
            row.messageDetail === 'removed Bot helps bot from the group',
            `the detail names who removed whom (${row.messageDetail})`
        );

        const messages = await build(messageId);
        const block = blockOf(messages.at(-1));
        expect(
            block.includes('#1 K-OFF [service: removed Bot helps bot from the group]'),
            `the model reads the event in the header (${block})`
        );
        expect(!block.includes('K-OFF\n<<EOF'), 'the old empty-block shape is gone');
        expect(block.endsWith('\n<<EOF\n'), `the block still ends with the terminator (${block})`);
    })
);

results.push(
    await runCase('a member who left by themselves reads "left the group"', async () => {
        const messageId = takeMessageId();
        const alice = sender(201, 'Alice');
        await ingest(messageUpdate(messageId, alice, { left_chat_member: alice }));
        const row = await rowOf(messageId);
        expect(row.messageKind === 'service', `the kind is service (${row.messageKind})`);
        expect(row.messageDetail === 'left the group', `the detail is a self-leave (${row.messageDetail})`);
        expect(blockOf((await build(messageId)).at(-1)).includes('[service: left the group]'), 'the context says left');
    })
);

results.push(
    await runCase('new members read as added, or joined when the sender is the joiner', async () => {
        const addedId = takeMessageId();
        await ingest(messageUpdate(addedId, sender(ADMIN, 'K-OFF'), {
            new_chat_members: [sender(201, 'Alice'), sender(202, 'Bob')],
        }));
        const added = await rowOf(addedId);
        expect(added.messageKind === 'service', `the kind is service (${added.messageKind})`);
        expect(
            added.messageDetail === 'added Alice and Bob to the group',
            `the detail lists both members (${added.messageDetail})`
        );

        const joinedId = takeMessageId();
        const alice = sender(203, 'Alice');
        await ingest(messageUpdate(joinedId, alice, { new_chat_members: [alice] }));
        const joined = await rowOf(joinedId);
        expect(joined.messageDetail === 'joined the group', `a self-join says joined (${joined.messageDetail})`);
    })
);

// ---- 2. Chat profile events: title, photo, pin ----

results.push(
    await runCase('group profile events read as what the admin did', async () => {
        const titleId = takeMessageId();
        await ingest(messageUpdate(titleId, sender(ADMIN, 'K-OFF'), { new_chat_title: 'K-ON 后援会' }));

        const photoId = takeMessageId();
        await ingest(messageUpdate(photoId, sender(ADMIN, 'K-OFF'), { new_chat_photo: [photoSize('chat-photo')] }));

        const deletePhotoId = takeMessageId();
        await ingest(messageUpdate(deletePhotoId, sender(ADMIN, 'K-OFF'), { delete_chat_photo: true }));

        const pinnedId = takeMessageId();
        await ingest(messageUpdate(pinnedId, sender(ADMIN, 'K-OFF'), {
            pinned_message: {
                message_id: takeMessageId(),
                date: SENT_AT - 60,
                chat: CHAT,
                text: '本群公告：周五开黑，请接龙报名。',
            },
        }));

        const inaccessiblePinId = takeMessageId();
        await ingest(messageUpdate(inaccessiblePinId, sender(ADMIN, 'K-OFF'), {
            pinned_message: { message_id: takeMessageId(), date: 0, chat: CHAT },
        }));

        const longPinId = takeMessageId();
        await ingest(messageUpdate(longPinId, sender(ADMIN, 'K-OFF'), {
            pinned_message: {
                message_id: takeMessageId(),
                date: SENT_AT - 60,
                chat: CHAT,
                text: '这是一条很长很长的置顶公告，'.repeat(8),
            },
        }));

        const details = [
            titleId,
            photoId,
            deletePhotoId,
            pinnedId,
            inaccessiblePinId,
            longPinId,
        ].map(async (id) => (await rowOf(id)).messageDetail);
        const [title, photo, deletePhoto, pinned, inaccessiblePin, longPin] = await Promise.all(details);

        expect(title === 'changed the group title to "K-ON 后援会"', `the title is quoted (${title})`);
        expect(photo === 'changed the group photo', `the photo event reads (${photo})`);
        expect(deletePhoto === 'removed the group photo', `the deletion reads (${deletePhoto})`);
        expect(
            pinned === 'pinned a message: "本群公告：周五开黑，请接龙报名。"',
            `the pinned message carries a short excerpt (${pinned})`
        );
        expect(inaccessiblePin === 'pinned a message', `an unreadable pin still says pinned (${inaccessiblePin})`);
        expect(
            (longPin ?? '').startsWith('pinned a message: "') && (longPin ?? '').endsWith('…"'),
            `a long pin is excerpted to 40 chars with an ellipsis (${longPin})`
        );
    })
);

// ---- 3. Forum topics, video chats, auto-delete ----

results.push(
    await runCase('forum, video-chat and auto-delete events read as their actions', async () => {
        const topicId = takeMessageId();
        await ingest(messageUpdate(topicId, sender(ADMIN, 'K-OFF'), {
            forum_topic_created: { name: '闲聊', icon_color: 0x6fb9f0 },
        }));

        const closedId = takeMessageId();
        await ingest(messageUpdate(closedId, sender(ADMIN, 'K-OFF'), { forum_topic_closed: {} }));

        const autoDeleteId = takeMessageId();
        await ingest(messageUpdate(autoDeleteId, sender(ADMIN, 'K-OFF'), {
            message_auto_delete_timer_changed: { message_auto_delete_time: 86_400 },
        }));

        const videoEndedId = takeMessageId();
        await ingest(messageUpdate(videoEndedId, sender(ADMIN, 'K-OFF'), {
            video_chat_ended: { duration: 720 },
        }));

        const videoScheduledId = takeMessageId();
        await ingest(messageUpdate(videoScheduledId, sender(ADMIN, 'K-OFF'), {
            video_chat_scheduled: { start_date: 1_802_000_000 },
        }));

        expect(
            (await rowOf(topicId)).messageDetail === 'created the topic "闲聊"',
            `the topic name is quoted (${(await rowOf(topicId)).messageDetail})`
        );
        expect((await rowOf(closedId)).messageKind === 'service', 'a closed topic is a service event');
        expect(
            (await rowOf(autoDeleteId)).messageDetail === 'set messages to auto-delete after 1 day',
            `the timer is humanized (${(await rowOf(autoDeleteId)).messageDetail})`
        );
        expect(
            (await rowOf(videoEndedId)).messageDetail === 'ended the video chat (12m)',
            `the duration is humanized (${(await rowOf(videoEndedId)).messageDetail})`
        );
        expect(
            (await rowOf(videoScheduledId)).messageDetail === 'scheduled a video chat for 2027-02-07T11:33:20.000Z',
            `the start is an ISO instant (${(await rowOf(videoScheduledId)).messageDetail})`
        );
    })
);

// ---- 4. Polls and quizzes ----

const pollOption = (text: string, index: number) => ({
    persistent_id: `option-${index}`,
    text,
    voter_count: 0,
});

results.push(
    await runCase('a poll keeps its question and options and renders as [sent a poll: …]', async () => {
        const messageId = takeMessageId();
        removedByAdminPollId = messageId;
        await ingest(messageUpdate(messageId, sender(ADMIN, 'K-OFF'), {
            poll: {
                id: 'poll-regular',
                question: '你是男娘吗',
                options: [pollOption('是', 0), pollOption('对的', 1), pollOption('yes', 2)],
                total_voter_count: 0,
                is_closed: false,
                is_anonymous: true,
                type: 'regular',
                allows_multiple_answers: false,
                allows_revoting: false,
                members_only: false,
            },
        }));

        const row = await rowOf(messageId);
        expect(row.messageKind === 'poll', `the kind is poll (${row.messageKind})`);
        expect(
            row.messageDetail === '"你是男娘吗" — 3 options: 是 / 对的 / yes (anonymous)',
            `the detail holds question and options (${row.messageDetail})`
        );

        const messages = await build(messageId);
        expect(
            blockOf(messages.at(-1)).includes(
                '[sent a poll: "你是男娘吗" — 3 options: 是 / 对的 / yes (anonymous)]'
            ),
            `the model reads the poll annotation (${blockOf(messages.at(-1))})`
        );
    })
);

results.push(
    await runCase('a quiz is a quiz, not a poll', async () => {
        const messageId = takeMessageId();
        await ingest(messageUpdate(messageId, sender(ADMIN, 'K-OFF'), {
            poll: {
                id: 'poll-quiz',
                question: '1+1=?',
                options: [pollOption('2', 0), pollOption('3', 1)],
                total_voter_count: 5,
                is_closed: false,
                is_anonymous: false,
                type: 'quiz',
                allows_multiple_answers: false,
                allows_revoting: false,
                members_only: false,
                correct_option_ids: [0],
            },
        }));

        const row = await rowOf(messageId);
        expect(row.messageKind === 'quiz', `the kind is quiz (${row.messageKind})`);
        expect(
            row.messageDetail === '"1+1=?" — 2 options: 2 / 3',
            `an anonymous-flag-free quiz detail (${row.messageDetail})`
        );
        expect(
            blockOf((await build(messageId)).at(-1)).includes('[sent a quiz: "1+1=?" — 2 options: 2 / 3]'),
            'the context label is a quiz'
        );
    })
);

// ---- 5. The other content types ----

const contentTypeUpdates = (): Array<{ name: string; update: Update; messageId: number }> => {
    const diceId = takeMessageId();
    const locationId = takeMessageId();
    const liveLocationId = takeMessageId();
    const venueId = takeMessageId();
    const contactId = takeMessageId();
    const checklistId = takeMessageId();
    const gameId = takeMessageId();
    const invoiceId = takeMessageId();
    const paidMediaId = takeMessageId();
    const storyId = takeMessageId();
    const from = sender(ADMIN, 'K-OFF');

    return [
        { name: 'dice', messageId: diceId, update: messageUpdate(diceId, from, { dice: { emoji: '🎲', value: 6 } }) },
        {
            name: 'location',
            messageId: locationId,
            update: messageUpdate(locationId, from, { location: { latitude: 31.2304, longitude: 121.4737 } }),
        },
        {
            name: 'live location',
            messageId: liveLocationId,
            update: messageUpdate(liveLocationId, from, {
                location: { latitude: 31.2304, longitude: 121.4737, live_period: 900 },
            }),
        },
        {
            name: 'venue',
            messageId: venueId,
            update: messageUpdate(venueId, from, {
                venue: {
                    location: { latitude: 31.2304, longitude: 121.4737 },
                    title: '上海中心大厦',
                    address: '银城中路 501 号',
                },
            }),
        },
        {
            name: 'contact',
            messageId: contactId,
            update: messageUpdate(contactId, from, {
                contact: {
                    phone_number: '+86 13800000000',
                    first_name: '张三',
                    vcard: 'BEGIN:VCARD\nFN:PRIVATE-VCARD-CONTENT\nEND:VCARD',
                },
            }),
        },
        {
            name: 'checklist',
            messageId: checklistId,
            update: messageUpdate(checklistId, from, {
                checklist: {
                    title: 'Packing',
                    tasks: [
                        { id: 1, text: '护照', completion_date: SENT_AT },
                        { id: 2, text: '充电器' },
                    ],
                },
            }),
        },
        {
            name: 'game',
            messageId: gameId,
            update: messageUpdate(gameId, from, {
                game: {
                    title: 'Tetris',
                    description: 'a game',
                    photo: [photoSize('game-photo')],
                    text: '',
                    text_entities: [],
                    animation: {
                        file_id: 'game-animation',
                        file_unique_id: 'game-animation-unique',
                        width: 320,
                        height: 240,
                        duration: 3,
                    },
                },
            }),
        },
        {
            name: 'invoice',
            messageId: invoiceId,
            update: messageUpdate(invoiceId, from, {
                invoice: {
                    title: 'T-shirt',
                    description: 'a shirt',
                    start_parameter: 'shirt',
                    currency: 'USD',
                    total_amount: 1234,
                },
            }),
        },
        {
            name: 'paid media',
            messageId: paidMediaId,
            update: messageUpdate(paidMediaId, from, {
                paid_media: {
                    star_count: 150,
                    paid_media: [
                        { type: 'photo', photo: [photoSize('paid-a')] },
                        { type: 'photo', photo: [photoSize('paid-b')] },
                        {
                            type: 'video',
                            video: {
                                file_id: 'paid-video',
                                file_unique_id: 'paid-video-unique',
                                width: 640,
                                height: 360,
                                duration: 10,
                            },
                        },
                    ],
                },
            }),
        },
        {
            name: 'story',
            messageId: storyId,
            update: messageUpdate(storyId, from, {
                story: { chat: { id: -1002000000000, type: 'channel', title: '测试频道' }, id: 7 },
            }),
        },
    ];
};

results.push(
    await runCase('the content types store a kind and a readable detail', async () => {
        const expected = [
            { kind: 'dice', detail: '🎲 6' },
            { kind: 'location', detail: '31.2304, 121.4737' },
            { kind: 'live_location', detail: '31.2304, 121.4737' },
            { kind: 'venue', detail: '上海中心大厦 — 银城中路 501 号 (31.2304, 121.4737)' },
            { kind: 'contact', detail: '张三, +86 13800000000, has vCard' },
            { kind: 'checklist', detail: '"Packing" — 2 tasks (1 done): 护照 / 充电器' },
            { kind: 'game', detail: '"Tetris"' },
            { kind: 'invoice', detail: '"T-shirt" — USD 12.34' },
            {
                kind: 'paid_media',
                detail: '2 photos and 1 video, 150 stars (paid content not viewable)',
            },
            { kind: 'story', detail: 'from 测试频道' },
        ];

        const updates = contentTypeUpdates();
        for (const entry of updates) await ingest(entry.update);

        for (const [index, entry] of updates.entries()) {
            const want = expected[index];
            if (want === undefined) throw new Error(`no expectation for ${entry.name}`);
            const row = await rowOf(entry.messageId);
            expect(
                row.messageKind === want.kind,
                `${entry.name}: kind ${want.kind} (got ${row.messageKind})`
            );
            expect(
                row.messageDetail === want.detail,
                `${entry.name}: detail ${JSON.stringify(want.detail)} (got ${JSON.stringify(row.messageDetail)})`
            );
        }

        const contact = await rowOf(updates[4]?.messageId ?? 0);
        expect(
            !(contact.messageDetail ?? '').includes('PRIVATE-VCARD-CONTENT'),
            'a vCard is never expanded into the detail'
        );

        const diceMessages = await build(updates[0]?.messageId ?? 0);
        expect(
            blockOf(diceMessages.at(-1)).includes('[sent a dice roll: 🎲 6]'),
            `the model reads the dice annotation (${blockOf(diceMessages.at(-1))})`
        );
        const contactMessages = await build(updates[4]?.messageId ?? 0);
        expect(
            blockOf(contactMessages.at(-1)).includes('[sent a contact: 张三, +86 13800000000, has vCard]'),
            'the model reads the contact annotation'
        );
    })
);

results.push(
    await runCase('the remaining service groups map to readable events', async () => {
        const serviceCase = (
            fields: Partial<IncomingMessage>,
            expected: string
        ): { messageId: number; update: Update; expected: string } => {
            const messageId = takeMessageId();
            return { messageId, update: messageUpdate(messageId, sender(ADMIN, 'K-OFF'), fields), expected };
        };
        const untypedServiceCase = (
            fields: Record<string, unknown>,
            expected: string
        ): { messageId: number; update: Update; expected: string } => {
            const messageId = takeMessageId();
            return {
                messageId,
                update: untypedMessageUpdate(messageId, sender(ADMIN, 'K-OFF'), fields),
                expected,
            };
        };

        const cases = [
            serviceCase({ forum_topic_edited: { name: '新话题' } }, 'renamed the topic to "新话题"'),
            serviceCase({ general_forum_topic_hidden: {} }, 'hid the General topic'),
            serviceCase({ forum_topic_reopened: {} }, 'reopened a forum topic'),
            serviceCase({ video_chat_started: {} }, 'started a video chat'),
            serviceCase(
                {
                    video_chat_participants_invited: {
                        users: [sender(301, 'A'), sender(302, 'B'), sender(303, 'C')],
                    },
                },
                'invited 3 people to a video chat'
            ),
            serviceCase({ boost_added: { boost_count: 2 } }, 'boosted the group (2 boosts)'),
            serviceCase({ migrate_to_chat_id: -1009999999999 }, 'the group was migrated to a supergroup'),
            serviceCase(
                { migrate_from_chat_id: -1009999999999 },
                'this message is from the old group before the migration'
            ),
            serviceCase({ group_chat_created: true }, 'the group was created'),
            serviceCase({ channel_chat_created: true }, 'the channel was created'),
            serviceCase(
                { giveaway_created: { prize_star_count: 100 } },
                'scheduled a giveaway (prize: 100 stars)'
            ),
            serviceCase(
                {
                    giveaway: {
                        chats: [],
                        winners_selection_date: SENT_AT,
                        winner_count: 5,
                        prize_star_count: 100,
                    },
                },
                'a giveaway is running: 5 winners, prize 100 stars'
            ),
            serviceCase(
                {
                    giveaway_winners: {
                        chat: CHAT,
                        giveaway_message_id: 1,
                        winners_selection_date: SENT_AT,
                        winner_count: 5,
                        winners: [],
                    },
                },
                'giveaway ended: 5 winners'
            ),
            serviceCase({ giveaway_completed: { winner_count: 5 } }, 'giveaway completed: 5 winners'),
            untypedServiceCase({ gift: { gift: { star_count: 50 } } }, 'sent a gift (50 stars)'),
            untypedServiceCase({ unique_gift: { gift: { name: 'Nebula' } } }, 'sent a unique gift "Nebula"'),
            untypedServiceCase(
                { gift_upgrade_sent: { gift: { star_count: 100 } } },
                'upgraded a gift (100 stars)'
            ),
            serviceCase(
                { checklist_tasks_done: { marked_as_done_task_ids: [1, 2] } },
                'marked 2 checklist tasks as done'
            ),
            serviceCase(
                { checklist_tasks_added: { tasks: [{ id: 1, text: '新任务' }] } },
                'added a task "新任务" to a checklist'
            ),
            serviceCase(
                { users_shared: { request_id: 1, users: [{ user_id: 1 }, { user_id: 2 }, { user_id: 3 }] } },
                'shared 3 users with the bot'
            ),
            serviceCase(
                { chat_shared: { request_id: 1, chat_id: -1009999999999, title: '分享的群' } },
                'shared the chat "分享的群" with the bot'
            ),
            serviceCase({ web_app_data: { data: 'x', button_text: '打开' } }, 'a Web App sent data'),
            serviceCase({ connected_website: 'example.com' }, 'logged in to example.com via Telegram'),
            serviceCase({ write_access_allowed: { from_request: true } }, 'allowed the bot to write messages'),
            serviceCase(
                {
                    successful_payment: {
                        currency: 'XTR',
                        total_amount: 100,
                        invoice_payload: 'p',
                        telegram_payment_charge_id: 't',
                        provider_payment_charge_id: 'p',
                    },
                },
                'payment received: 100 stars'
            ),
            serviceCase(
                {
                    refunded_payment: {
                        currency: 'XTR',
                        total_amount: 100,
                        invoice_payload: 'p',
                        telegram_payment_charge_id: 't',
                    },
                },
                'payment refunded: 100 stars'
            ),
            untypedServiceCase({ passport_data: {} }, 'Telegram Passport data was shared'),
            serviceCase(
                {
                    proximity_alert_triggered: {
                        traveler: sender(301, 'Traveller'),
                        watcher: sender(302, 'Watcher'),
                        distance: 30,
                    },
                },
                'triggered a proximity alert for Watcher'
            ),
            serviceCase(
                { chat_owner_changed: { new_owner: sender(304, 'Alice') } },
                'the group owner changed to Alice'
            ),
            serviceCase(
                { community_chat_added: { community: { id: 1, name: 'K-ON' } } },
                'the chat was added to the community "K-ON"'
            ),
            serviceCase(
                { managed_bot_created: { bot: { id: 9, is_bot: true, first_name: 'Helper', username: 'helper_bot' } } },
                'created a bot managed by this bot (@helper_bot)'
            ),
            serviceCase(
                { direct_message_price_changed: { are_direct_messages_enabled: false } },
                'changed the direct message price'
            ),
            serviceCase(
                { paid_message_price_changed: { paid_message_star_count: 7 } },
                'changed the paid message price to 7 stars'
            ),
            untypedServiceCase({ paid_messages_waived: true }, 'waived the paid message price'),
            serviceCase(
                { poll_option_added: { option_persistent_id: 'o-1', option_text: '新选项' } },
                'added the poll option "新选项"'
            ),
            serviceCase(
                { poll_option_deleted: { option_persistent_id: 'o-1', option_text: '旧选项' } },
                'deleted the poll option "旧选项"'
            ),
            serviceCase({ suggested_post_approved: { send_date: SENT_AT } }, 'a suggested post was approved'),
            serviceCase({ suggested_post_declined: {} }, 'a suggested post was declined'),
            untypedServiceCase({ chat_background_set: {} }, 'changed the chat background'),
        ];

        for (const entry of cases) await ingest(entry.update);
        for (const entry of cases) {
            const row = await rowOf(entry.messageId);
            expect(row.messageKind === 'service', `${entry.expected}: kind service (got ${row.messageKind})`);
            expect(
                row.messageDetail === entry.expected,
                `${entry.expected}: detail (got ${JSON.stringify(row.messageDetail)})`
            );
        }
    })
);

results.push(
    await runCase('a widget and a TON transfer are detected without their types', async () => {
        const widgetId = takeMessageId();
        await ingest(untypedMessageUpdate(widgetId, sender(ADMIN, 'K-OFF'), {
            widget: { kind: 'html', payload: '<b>hi</b>' },
        }));
        const widget = await rowOf(widgetId);
        expect(widget.messageKind === 'widget', `the widget kind is stored (${widget.messageKind})`);
        expect(widget.messageDetail === null, `the widget needs no detail (${widget.messageDetail})`);
        expect(
            blockOf((await build(widgetId)).at(-1)).includes('[sent an HTML widget]'),
            'the model is told there was an HTML widget'
        );

        const tonId = takeMessageId();
        await ingest(untypedMessageUpdate(tonId, sender(ADMIN, 'K-OFF'), {
            ton_wallet_transfer: { amount: 1_000_000_000 },
        }));
        const ton = await rowOf(tonId);
        expect(ton.messageKind === 'service', `a TON transfer is a service event (${ton.messageKind})`);
        expect(ton.messageDetail === 'TON wallet transfer', `the TON detail (${ton.messageDetail})`);
    })
);

// ---- 6. Unknown future types and the old empty block ----

results.push(
    await runCase('a type this build does not know renders an explicit unsupported annotation', async () => {
        const messageId = takeMessageId();
        await ingest(untypedMessageUpdate(messageId, sender(ADMIN, 'K-OFF'), {
            future_service_event: { payload: 1 },
        }));

        const row = await rowOf(messageId);
        expect(row.messageKind === 'unsupported', `the kind is unsupported (${row.messageKind})`);
        expect(
            row.messageDetail === 'Bot API field "future_service_event"',
            `the detail names the unread field (${row.messageDetail})`
        );
        const block = blockOf((await build(messageId)).at(-1));
        expect(
            block.includes('[unsupported Telegram message type: Bot API field "future_service_event"]'),
            `the model reads the unsupported annotation (${block})`
        );
        expect(block.endsWith('\n<<EOF\n'), `the fallback block still ends with the terminator (${block})`);
    })
);

results.push(
    await runCase('a row stored before the columns existed falls back to "content was not stored"', async () => {
        const messageId = await seedMessage({ text: null });
        const messages = await build(messageId);
        const block = blockOf(messages.at(-1));
        expect(
            block.includes('[unsupported Telegram message type — content was not stored]'),
            `the old row gets the fallback annotation (${block})`
        );
        const rendered = renderOf(messages);
        expect(!rendered.includes('still being generated'), 'a user row never reads as a streaming bot reply');
        expect(!rendered.includes('ended without producing any text'), 'a user row never reads as an empty bot reply');
    })
);

// ---- 7. Plain text and media keep their previous shape ----

results.push(
    await runCase('text and media rows store no kind and render as before', async () => {
        const textId = takeMessageId();
        await ingest(messageUpdate(textId, sender(USER_ID, 'tester'), { text: '普通的文字' }));
        const textRow = await rowOf(textId);
        expect(textRow.messageKind === null && textRow.messageDetail === null, 'a text row has no kind');
        const textBlock = blockOf((await build(textId)).at(-1));
        expect(textBlock.startsWith('#1 tester: 普通的文字'), `the text header is unchanged (${textBlock})`);

        const photoId = takeMessageId();
        await ingest(messageUpdate(photoId, sender(USER_ID, 'tester'), { photo: [photoSize('plain-photo')] }));
        await waitForMedia(photoId);
        const photoRow = await rowOf(photoId);
        expect(photoRow.messageKind === null, `a photo row has no kind (${photoRow.messageKind})`);
        expect(
            photoRow.mediaHint === 'a picture — failed to download, you cannot see it',
            `the media hint is unchanged (${photoRow.mediaHint})`
        );
        expect(
            blockOf((await build(photoId)).at(-1)).includes(
                '[sent a picture — failed to download, you cannot see it]'
            ),
            'the media annotation is unchanged'
        );

        const livePhotoId = takeMessageId();
        const livePhoto = photoSize('live-photo');
        await ingest(messageUpdate(livePhotoId, sender(USER_ID, 'tester'), {
            photo: [livePhoto],
            live_photo: {
                file_id: 'live-photo-video',
                file_unique_id: 'live-photo-video-unique',
                width: 90,
                height: 90,
                duration: 2,
                mime_type: 'video/mp4',
                photo: [livePhoto],
            },
        }));
        await waitForMedia(livePhotoId);
        const liveRow = await rowOf(livePhotoId);
        expect(liveRow.messageKind === null, 'a live photo adds no kind');
        expect(
            (liveRow.mediaHint ?? '').startsWith('a picture (live photo)'),
            `the live photo refines the hint instead (${liveRow.mediaHint})`
        );
    })
);

results.push(
    await runCase('a media group keeps the parent/sub-image shape and stores no kind', async () => {
        const mediaGroupId = `album-${takeMessageId()}`;
        const parentId = takeMessageId();
        await ingest(messageUpdate(parentId, sender(USER_ID, 'tester'), {
            media_group_id: mediaGroupId,
            photo: [photoSize('album-a')],
        }));
        await waitForMedia(parentId);

        const childId = takeMessageId();
        await ingest(messageUpdate(childId, sender(USER_ID, 'tester'), {
            media_group_id: mediaGroupId,
            photo: [photoSize('album-b')],
        }));
        await waitForMedia(childId);

        const parent = await rowOf(parentId);
        const child = await rowOf(childId);
        expect(parent.messageKind === null, `the album parent has no kind (${parent.messageKind})`);
        expect(child.messageKind === null, `the sub-image row has no kind (${child.messageKind})`);
        expect(child.text === `sub image of [${parentId}]`, `the sub-image marker is unchanged (${child.text})`);
        const block = blockOf((await build(parentId)).at(-1));
        expect(block.includes('[sent some pictures'), `the album reads as pictures (${block})`);
        expect(!block.includes('unsupported'), 'an album never gets the unsupported fallback');
    })
);

results.push(
    await runCase('a rich message stores no kind and renders its markdown', async () => {
        const messageId = takeMessageId();
        await ingest(messageUpdate(messageId, sender(USER_ID, 'tester'), {
            rich_message: {
                blocks: [
                    { type: 'paragraph', text: '富文本内容' },
                    { type: 'photo', photo: [photoSize('rich-photo')] },
                ],
            },
        }));
        await waitForMedia(messageId);
        const row = await rowOf(messageId);
        expect(row.messageKind === null, `a rich message has no kind (${row.messageKind})`);
        const block = blockOf((await build(messageId)).at(-1));
        expect(block.includes('富文本内容'), `the rich text is stored and read (${block})`);
        expect(!block.includes('unsupported'), 'a rich message never gets the fallback');
    })
);

// ---- 8. Existing special cases: /chat summons and deletions ----

results.push(
    await runCase('a /chat summon without words keeps its annotation, not the fallback', async () => {
        const messageId = takeMessageId();
        await ingest(messageUpdate(messageId, sender(USER_ID, 'tester'), { text: '/chat 1' }));
        const row = await rowOf(messageId);
        expect(row.text === '', `the command itself is not stored as text (${JSON.stringify(row.text)})`);
        expect(row.chatCommand !== null, 'the summon is marked in chatCommand');
        expect(row.messageKind === null, `a /chat summon stores no kind (${row.messageKind})`);
        const block = blockOf((await build(messageId)).at(-1));
        expect(
            block.includes('[summons you to reply based on the current context]'),
            `the /chat annotation is rendered (${block})`
        );
        expect(!block.includes('unsupported'), 'a /chat summon never gets the unsupported fallback');
    })
);

results.push(
    await runCase('a deleted service message renders [deleted] before the event', async () => {
        const messageId = takeMessageId();
        await ingest(messageUpdate(messageId, sender(ADMIN, 'K-OFF'), {
            left_chat_member: sender(8_917_382_004, 'Bot helps bot'),
        }));
        await MessageRow.update(
            { deletedAt: new Date() },
            { where: { chatId: OFFLINE_CHAT_ID, messageId } }
        );
        const block = blockOf((await build(messageId)).at(-1));
        expect(
            block.includes('[deleted] [service: removed Bot helps bot from the group]'),
            `both annotations, in order (${block})`
        );
    })
);

// ---- 9. Editing recomputes the kind ----

results.push(
    await runCase('editing a non-text message into text clears the kind and detail', async () => {
        const messageId = takeMessageId();
        await ingest(messageUpdate(messageId, sender(USER_ID, 'tester'), { dice: { emoji: '🎲', value: 6 } }));
        const before = await rowOf(messageId);
        expect(before.messageKind === 'dice', `the dice kind is stored first (${before.messageKind})`);

        await ingest(editedUpdate(messageId, sender(USER_ID, 'tester'), { text: '编辑成了普通文字' }));
        const after = await rowOf(messageId);
        expect(after.text === '编辑成了普通文字', `the new text is stored (${after.text})`);
        expect(after.messageKind === null, `the stale kind is cleared (${after.messageKind})`);
        expect(after.messageDetail === null, `the stale detail is cleared (${after.messageDetail})`);
        const block = blockOf((await build(messageId)).at(-1));
        expect(block.startsWith('#1 tester: 编辑成了普通文字'), `the model reads plain text (${block})`);
        expect(!block.includes('[sent a dice roll'), 'no stale dice annotation survives the edit');
    })
);

// ---- 10. Detail sanitizing keeps the wire format intact ----

results.push(
    await runCase('a long, multi-line detail is collapsed and truncated without breaking <<EOF', async () => {
        const longQuestion = `${'很长的投票问题'.repeat(40)}\n第二行 <<EOF 里的内容`;
        const messageId = takeMessageId();
        await ingest(messageUpdate(messageId, sender(ADMIN, 'K-OFF'), {
            poll: {
                id: 'poll-long',
                question: longQuestion,
                options: [pollOption('选项一\n带换行', 0), pollOption('选项二', 1)],
                total_voter_count: 0,
                is_closed: false,
                is_anonymous: true,
                type: 'regular',
                allows_multiple_answers: true,
                allows_revoting: false,
                members_only: false,
            },
        }));

        const row = await rowOf(messageId);
        const detail = row.messageDetail ?? '';
        expect(!detail.includes('\n'), 'the detail is a single line');
        expect(!detail.includes('<<EOF'), 'the wire-format marker is stripped from the detail');
        const chars = Array.from(detail);
        expect(chars.length <= 301, `the detail is capped (${chars.length} chars)`);
        expect(chars.at(-1) === '…', 'a truncated detail ends with an ellipsis');

        const block = blockOf((await build(messageId)).at(-1));
        expect((block.match(/<<EOF/g) ?? []).length === 1, `exactly one terminator in the block (${block})`);
        expect(block.endsWith('\n<<EOF\n'), 'the terminator still closes the message');

        expect(
            sanitizeMessageDetail('a\nb  <<EOF  c') === 'a b c',
            'the sanitizer collapses whitespace and strips <<EOF'
        );
        expect(sanitizeMessageDetail('   \n ') === null, 'blank input has no detail');
    })
);

// ---- 11. Model capabilities do not filter the annotations ----

results.push(
    await runCase('a text-only model still reads the type annotation', async () => {
        const messages = await build(removedByAdminPollId, { capabilities: TEXT_ONLY });
        const rendered = renderOf(messages);
        expect(
            rendered.includes('[sent a poll: "你是男娘吗" — 3 options: 是 / 对的 / yes (anonymous)]'),
            `the annotation survives capability filtering (${rendered})`
        );
    })
);

// ---- 12. Reply targets that name a type ----

results.push(
    await runCase('replying to a poll names the type, in and out of the context', async () => {
        const replyId = takeMessageId();
        await ingest(messageUpdate(replyId, sender(USER_ID, 'tester'), {
            text: '这是什么',
            reply_to_message: replyTargetOf(removedByAdminPollId),
        }));

        const inContext = await build(replyId);
        const inContextWire = renderOf(inContext);
        expect(
            inContextWire.includes('[replying to #1 K-OFF (a poll)]'),
            `an in-context poll target is named by type (${inContextWire})`
        );

        const outOfContext = await build(replyId, { excludeMessageIds: [removedByAdminPollId] });
        const outOfContextWire = renderOf(outOfContext);
        expect(
            outOfContextWire.includes('[replying to K-OFF: a poll]'),
            `an out-of-context poll target is named, not "cannot see" (${outOfContextWire})`
        );
        expect(!outOfContextWire.includes('you cannot see'), 'the poll target is not reported as unseen');
    })
);

// ---- 13. The two fallbacks never collide ----

results.push(
    await runCase('an empty bot reply and an unsupported user row read differently', async () => {
        const unsupportedId = await seedMessage({ text: null });
        const botReplyId = await seedMessage({ text: null, fromBot: true, replyToId: unsupportedId });
        const triggerId = await seedMessage({ text: '继续', replyToId: botReplyId });

        const rendered = renderOf(await build(triggerId));
        expect(
            rendered.includes('[unsupported Telegram message type — content was not stored]'),
            `the user row reads as an unsupported type (${rendered})`
        );
        expect(
            rendered.includes('ended without producing any text'),
            'the bot turn keeps its interrupted-reply note'
        );
        expect(!rendered.includes('message lost'), 'neither turn reads as a lost message');
        expect(rendered.includes('[#2]'), 'the bot turn keeps its own number label');
    })
);

// ---- 14. The panel tree sees the same annotation ----

results.push(
    await runCase('the panel tree annotations include the service annotation', async () => {
        const assembled = await assembleContextMessages(OFFLINE_CHAT_ID, removedServiceId, { recover: false });
        const message = assembled.messages.find((candidate) => candidate.messageId === removedServiceId);
        if (message === undefined) throw new Error('the service message is not in its own context');
        const annotations = await describeMessageAnnotations(message, {
            numbering: assembled.numbering,
            exclusions: assembled.exclusions,
        });
        expect(
            annotations.includes('[service: removed Bot helps bot from the group]'),
            `the panel reads the kind annotation (${JSON.stringify(annotations)})`
        );
    })
);

// ---- 15. The migration restores the columns on an old database ----

results.push(
    await runCase('the columns are added to a database that predates them', async () => {
        const columnsOf = async (): Promise<Set<string>> => {
            const columns = await sequelize.query<{ name: string }>(
                'PRAGMA table_info(telegram_messages)',
                { type: QueryTypes.SELECT }
            );
            return new Set(columns.map((column) => column.name));
        };
        const fresh = await columnsOf();
        expect(fresh.has('messageKind') && fresh.has('messageDetail'), 'both columns exist after startup');

        await sequelize.query('ALTER TABLE telegram_messages DROP COLUMN messageKind');
        await sequelize.query('ALTER TABLE telegram_messages DROP COLUMN messageDetail');
        const old = await columnsOf();
        expect(!old.has('messageKind') && !old.has('messageDetail'), 'simulated old database without the columns');

        await runSchemaMigrations();
        const migrated = await columnsOf();
        expect(
            migrated.has('messageKind') && migrated.has('messageDetail'),
            'the migration restores both columns'
        );
    })
);

await reportResults(results);
