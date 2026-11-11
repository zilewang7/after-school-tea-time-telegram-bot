/**
 * Offline cases for fetch_image's avatar lane: the target syntax, the getChat
 * lookup (through a fake Bot API), which size `view` picks, the ten-minute
 * resolution cache, the repeated-read short circuit, and the sentences every
 * failure hands back.
 *
 * Run: npx tsx scripts/offline/avatar.mts
 *
 * No database, no network: the tool takes its Bot API and its downloader by
 * injection, and a JPEG header is all the mime sniff needs.
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import type { AvatarApi, AvatarChat } from '../../src/services/avatar-service.js';
import type { ContextIndex } from '../../src/reply/context-index.js';
import type { ToolResult } from '../../src/ai/tools/tool-types.js';

// The platforms build their clients at import time; nothing here sends a request
for (const key of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GROK_API_KEY', 'MIMO_API_KEY']) {
    process.env[key] ||= 'offline-placeholder';
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const CHAT_ID = -100;

const replyTools = await import('../../src/reply/tools/index.js');
const avatarService = await import('../../src/services/avatar-service.js');
const sections = await import('../../src/ai/system-prompt/sections.js');

const { createFetchImageTool, createReplyMediaState, describeFetchImageRequest, parseAvatarTarget } = replyTools;
const { parseFetchImageArgs } = await import('../../src/reply/tools/media-tool-args.js');
const { clearAvatarCache } = avatarService;

const signal = new AbortController().signal;

class FakeTelegramError extends Error {
    readonly error_code = 400;
    readonly description: string;

    constructor(description: string) {
        super(description);
        this.description = description;
    }
}

interface FakeApi {
    readonly api: AvatarApi;
    readonly calls: Array<number | string>;
}

/** A Bot API whose getChat answers from a map and records every argument */
const fakeApi = (chats: ReadonlyMap<string, AvatarChat>): FakeApi => {
    const calls: Array<number | string> = [];
    const api: AvatarApi = {
        getChat: async (chatId) => {
            calls.push(chatId);
            const chat = chats.get(String(chatId).toLowerCase());
            if (chat === undefined) throw new FakeTelegramError('Bad Request: chat not found');
            return chat;
        },
        getFile: async () => ({ file_path: '/tmp/offline-avatar.jpg' }),
    };
    return { api, calls };
};

const chatWithPhoto = (chat: AvatarChat, big = 'big', small = 'small'): AvatarChat => ({
    ...chat,
    photo: { small_file_id: small, big_file_id: big },
});

const contextIndex: ContextIndex = new Map([
    [1, { number: 1, messageId: 10, fromBot: false, authorUserId: 1001, authorName: '张三', images: [], imageCount: 0 }],
    [2, { number: 2, messageId: 11, fromBot: true, authorUserId: 7777, authorName: 'K-ON', images: [], imageCount: 0 }],
    [3, { number: 3, messageId: 12, fromBot: false, authorUserId: null, images: [], imageCount: 0 }],
]);

const parse = (text: string, botUserId: number | null = 7777) =>
    parseAvatarTarget(text, { chatId: CHAT_ID, botUserId, contextIndex });

interface ToolHarness {
    readonly read: (args: Record<string, unknown>) => Promise<ToolResult>;
    readonly downloads: string[];
    readonly calls: Array<number | string>;
}

/** fetch_image with only the avatar lane wired, over one fake Bot API */
const avatarTool = (options: {
    readonly chats: ReadonlyMap<string, AvatarChat>;
    readonly lookupUsername?: (username: string) => Promise<number | null>;
    readonly botUserId?: number | null;
    readonly now?: () => number;
}): ToolHarness => {
    const fake = fakeApi(options.chats);
    const downloads: string[] = [];
    const state = createReplyMediaState();
    const tool = createFetchImageTool({
        state,
        dependencies: { fetchImage: async () => ({ ok: false, error: 'offline' }) },
        avatar: {
            chatId: CHAT_ID,
            botUserId: options.botUserId === undefined ? 7777 : options.botUserId,
            contextIndex,
            dependencies: {
                api: fake.api,
                download: async (fileId) => {
                    downloads.push(fileId);
                    return JPEG;
                },
                ...(options.lookupUsername === undefined ? {} : { lookupUsername: options.lookupUsername }),
                ...(options.now === undefined ? {} : { now: options.now }),
            },
        },
    });
    return {
        read: (args) => tool.execute(args, signal),
        downloads,
        calls: fake.calls,
    };
};

const groupChat: AvatarChat = { id: CHAT_ID, type: 'supergroup', title: '测试群' };

const results: CaseResult[] = [];

results.push(
    await runCase('the avatar target syntax is one small, unambiguous set', async () => {
        const me = parse('me');
        expect(me.ok && me.target.kind === 'bot', 'me is the bot');
        const upper = parse('BOT');
        expect(upper.ok && upper.target.kind === 'bot', 'keywords are case-insensitive');
        const missingBotId = parse('me', null);
        expect(!missingBotId.ok && missingBotId.error.includes('BOT_USER_ID'), 'me needs a bot user id');

        const chat = parse('chat');
        expect(chat.ok && chat.target.kind === 'chat' && chat.target.chatId === CHAT_ID, 'chat is this chat');
        const thisChat = parse('this');
        expect(thisChat.ok && thisChat.target.kind === 'chat', 'this is an alias');

        const author = parse('#1');
        expect(
            author.ok && author.target.kind === 'user' && author.target.userId === 1001,
            '#1 is the author of context message 1'
        );
        expect(
            author.ok && author.target.kind === 'user' && author.target.context?.name === '张三',
            'the context name rides along for the label'
        );
        const spaced = parse('# 1');
        expect(spaced.ok && spaced.target.kind === 'user', 'a space after # is accepted');
        const missing = parse('#9');
        expect(!missing.ok && missing.error.includes('不在当前上下文'), 'an unknown context number is refused');
        const anonymous = parse('#3');
        expect(!anonymous.ok && anonymous.error.includes('没有记录作者 id'), 'a message without an author id is refused');

        const handle = parse('@Durov');
        expect(handle.ok && handle.target.kind === 'username' && handle.target.username === 'durov', '@handle is lowercased');
        const userId = parse('603421700');
        expect(userId.ok && userId.target.kind === 'user' && userId.target.userId === 603421700, 'a positive id is a user');
        const chatId = parse('-1001415974153');
        expect(chatId.ok && chatId.target.kind === 'chat' && chatId.target.chatId === -1001415974153, 'a negative id is a chat');

        const link = parse('https://t.me/durov');
        expect(link.ok && link.target.kind === 'username' && link.target.username === 'durov', 'a t.me link is its handle');
        const bareLink = parse('t.me/durov');
        expect(bareLink.ok && bareLink.target.kind === 'username', 'a bare t.me link works too');
        const previewLink = parse('https://t.me/s/durov');
        expect(previewLink.ok && previewLink.target.kind === 'username', 'a preview link names the channel');
        const internal = parse('https://t.me/c/1415974153/850104');
        expect(
            internal.ok && internal.target.kind === 'chat' && internal.target.chatId === -1001415974153,
            'an internal link becomes its chat id'
        );
        const invite = parse('t.me/+abcdef');
        expect(!invite.ok && invite.error.includes('邀请链接'), 'an invite link has no public name');
        const nonsense = parse('群头像');
        expect(!nonsense.ok && nonsense.error.includes('无法识别'), 'free text is refused with the forms to use');
        const zero = parse('0');
        expect(!zero.ok, 'zero is not an id');
    })
);

results.push(
    await runCase('fetch_image takes avatar as exactly one source', async () => {
        const alone = parseFetchImageArgs({ avatar: 'me' });
        expect(alone.ok && alone.args.avatar === 'me', 'avatar alone is accepted');
        expect(!parseFetchImageArgs({ avatar: 'me', url: 'https://example.com/a.png' }).ok, 'two sources are refused');
        expect(!parseFetchImageArgs({ avatar: '' }).ok, 'an empty avatar is refused');
        expect(!parseFetchImageArgs({ avatar: 42 }).ok, 'a non-string avatar is refused');
        const withIndex = parseFetchImageArgs({ avatar: 'me', image: 2 });
        expect(!withIndex.ok && withIndex.error.includes('image 只能和 history'), 'image still only goes with history');
        expect(parseFetchImageArgs({ history: 'h3', image: 2 }).ok, 'history + image is untouched');
    })
);

results.push(
    await runCase('a chat avatar is read, numbered and reused', async () => {
        clearAvatarCache();
        const tool = avatarTool({ chats: new Map([[String(CHAT_ID), chatWithPhoto(groupChat, 'big-chat', 'small-chat')]]) });
        const read = await tool.read({ avatar: 'chat' });
        expect(!read.isError, `the group avatar is read (got ${read.content})`);
        expect(read.content.includes('已读取 img1'), 'it is numbered img1');
        expect(read.content.includes('群聊「测试群」的头像'), 'the label names the chat');
        expect(read.content.includes('640 档'), 'the default is the big size');
        expect(read.modelImages?.length === 1 && read.modelImages[0]?.mimeType === 'image/jpeg', 'the model sees a JPEG');
        expect(tool.downloads[0] === 'big-chat', 'the big file id is downloaded');

        const again = await tool.read({ avatar: 'chat' });
        expect(again.content.includes('已经读过 img1'), `a second read reuses it (got ${again.content})`);
        expect(!again.modelImages || again.modelImages.length === 0, 'no bytes are sent twice');
        expect(tool.downloads.length === 1, 'and nothing is downloaded twice');

        const thumbnail = await tool.read({ avatar: 'chat', view: 'thumbnail' });
        expect(!thumbnail.isError && thumbnail.content.includes('img2'), 'the thumbnail is its own picture');
        expect(thumbnail.content.includes('160 档缩略图'), 'and says which size it is');
        expect(tool.downloads[1] === 'small-chat', 'the small file id is downloaded');
    })
);

results.push(
    await runCase('a context author avatar comes from #N', async () => {
        clearAvatarCache();
        const tool = avatarTool({
            chats: new Map([
                ['1001', chatWithPhoto({ id: 1001, type: 'private', first_name: '张三', username: 'zhangsan' })],
            ]),
        });
        const read = await tool.read({ avatar: '#1' });
        expect(!read.isError, `the author avatar is read (got ${read.content})`);
        expect(read.content.includes('#1 作者「张三」的头像'), 'the label points at the context number');
        expect(tool.calls[0] === 1001, 'getChat is asked for the author id');
    })
);

results.push(
    await runCase('me is the bot itself', async () => {
        clearAvatarCache();
        const tool = avatarTool({
            chats: new Map([['7777', chatWithPhoto({ id: 7777, type: 'private', first_name: 'K-ON' })]]),
        });
        const read = await tool.read({ avatar: 'me' });
        expect(!read.isError && read.content.includes('我的头像'), `the bot avatar is read (got ${read.content})`);
        expect(tool.calls[0] === 7777, 'getChat is asked for BOT_USER_ID');
    })
);

results.push(
    await runCase('a username is tried through the roster before the public lookup', async () => {
        clearAvatarCache();
        const throughRoster = avatarTool({
            chats: new Map([
                ['1001', chatWithPhoto({ id: 1001, type: 'private', first_name: '张三', username: 'zhangsan' })],
            ]),
            lookupUsername: async () => 1001,
        });
        const read = await throughRoster.read({ avatar: '@zhangsan' });
        expect(!read.isError, `the roster maps the handle (got ${read.content})`);
        expect(throughRoster.calls.length === 1 && throughRoster.calls[0] === 1001, 'only the numeric lookup is used');

        clearAvatarCache();
        const publicLookup = avatarTool({
            chats: new Map([
                ['@durov', chatWithPhoto({ id: -1001006503122, type: 'channel', title: 'Pavel Durov', username: 'durov' })],
            ]),
            lookupUsername: async () => null,
        });
        const channel = await publicLookup.read({ avatar: '@durov' });
        expect(
            !channel.isError && channel.content.includes('频道「Pavel Durov」（@durov）的头像'),
            `a channel resolves publicly (got ${channel.content})`
        );
        expect(publicLookup.calls[0] === '@durov', 'getChat gets the handle');

        clearAvatarCache();
        const staleRoster = avatarTool({
            chats: new Map([
                ['1001', chatWithPhoto({ id: 1001, type: 'private', first_name: '旧名字', username: 'oldname' })],
                ['@durov', chatWithPhoto({ id: -1001006503122, type: 'channel', title: 'Pavel Durov', username: 'durov' })],
            ]),
            lookupUsername: async () => 1001,
        });
        const moved = await staleRoster.read({ avatar: '@durov' });
        expect(!moved.isError, `a stale roster row falls back to the handle (got ${moved.content})`);
        expect(staleRoster.calls.join(',') === '1001,@durov', `both lookups happen in order (got ${staleRoster.calls.join(',')})`);
    })
);

results.push(
    await runCase('a target without a picture is a sentence, not a crash', async () => {
        clearAvatarCache();
        const tool = avatarTool({ chats: new Map([[String(CHAT_ID), groupChat]]) });
        const read = await tool.read({ avatar: 'chat' });
        expect(read.isError, 'no picture is an error result');
        expect(read.content.includes('没有设置头像'), `the model is told why (got ${read.content})`);
    })
);

results.push(
    await runCase('a missing chat and an unknown user each get their own sentence', async () => {
        clearAvatarCache();
        const missingChat = await avatarTool({ chats: new Map() }).read({ avatar: 'chat' });
        expect(missingChat.isError && missingChat.content.includes('找不到聊天 -100'), `a missing chat is named (got ${missingChat.content})`);

        clearAvatarCache();
        const missingUser = await avatarTool({ chats: new Map() }).read({ avatar: '3' });
        expect(
            missingUser.isError && missingUser.content.includes("上下文编号要写成 '#3'"),
            `a bare number points at the # form (got ${missingUser.content})`
        );

        clearAvatarCache();
        const noBotId = await avatarTool({ chats: new Map(), botUserId: null }).read({ avatar: 'me' });
        expect(noBotId.isError && noBotId.content.includes('BOT_USER_ID'), 'me without a bot id is refused');
    })
);

results.push(
    await runCase('the resolution cache answers the next reply without getChat', async () => {
        clearAvatarCache();
        const first = avatarTool({
            chats: new Map([[String(CHAT_ID), chatWithPhoto(groupChat, 'big-a')]]),
            now: () => 0,
        });
        await first.read({ avatar: 'chat' });
        expect(first.downloads[0] === 'big-a', 'the first reply downloads the picture');

        const second = avatarTool({
            chats: new Map([[String(CHAT_ID), chatWithPhoto(groupChat, 'big-b')]]),
            now: () => 60_000,
        });
        const cached = await second.read({ avatar: 'chat' });
        expect(!cached.isError, `the cached resolution still answers (got ${cached.content})`);
        expect(second.calls.length === 0, 'getChat is not called again inside the TTL');
        expect(second.downloads[0] === 'big-a', 'the cached file id is used');

        const expired = avatarTool({
            chats: new Map([[String(CHAT_ID), chatWithPhoto(groupChat, 'big-b')]]),
            now: () => 11 * 60_000,
        });
        const fresh = await expired.read({ avatar: 'chat' });
        expect(!fresh.isError, 'the expired entry is refreshed');
        expect(expired.calls.length === 1, 'getChat is called once the TTL passed');
        expect(expired.downloads[0] === 'big-b', 'and the fresh picture is downloaded');
    })
);

results.push(
    await runCase('the tool advertises the avatar argument only when the lane is wired', async () => {
        const wired = createFetchImageTool({
            state: createReplyMediaState(),
            dependencies: { fetchImage: async () => ({ ok: false, error: 'offline' }) },
            avatar: {
                chatId: CHAT_ID,
                botUserId: 7777,
                contextIndex,
                dependencies: { api: fakeApi(new Map()).api, download: async () => JPEG },
            },
        });
        const wiredProperties = wired.definition.inputSchema.properties;
        expect(
            typeof wiredProperties === 'object' && wiredProperties !== null && 'avatar' in wiredProperties,
            'the schema carries avatar'
        );
        expect(wired.definition.description.includes('avatar'), 'the description explains avatar');

        const plain = createFetchImageTool({
            state: createReplyMediaState(),
            dependencies: { fetchImage: async () => ({ ok: false, error: 'offline' }) },
        });
        const plainProperties = plain.definition.inputSchema.properties;
        expect(
            typeof plainProperties === 'object' && plainProperties !== null && !('avatar' in plainProperties),
            'a turn without the lane does not declare it'
        );
    })
);

results.push(
    await runCase('the system prompt names avatars exactly when fetch_image is offered', async () => {
        const base = {
            smsOwner: null,
            imageTools: false,
            imageReverseSearch: false,
            imageGenerate: false,
            stickerTools: false,
            fileTools: false,
            historyTools: false,
            harnessIssues: false,
            widget: false,
        };
        const withFetch = sections.buildCapabilitiesSection({ ...base, imageFetch: true });
        expect(withFetch.includes('fetch_image(avatar=…)'), 'the capability line mentions avatar');
        const withoutFetch = sections.buildCapabilitiesSection({ ...base, imageFetch: false });
        expect(!withoutFetch.includes('avatar'), 'and disappears with the tool');
    })
);

results.push(
    await runCase('a refused avatar read names the argument the model gave', async () => {
        expect(describeFetchImageRequest({ avatar: '#3' }) === 'avatar=#3', 'the request is named by avatar');
    })
);

reportResults(results);
