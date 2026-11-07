/**
 * Offline cases for splicing conversations from the panel (POST …/links):
 * accepted and refused links come out exactly as `/chat <link>` classifies
 * them (this chat, another chat, missing, already in the tree; both the
 * `t.me/c/<id>/N` and the `t.me/<username>/N` form); the edge's source is the
 * conversation root; a non-root or unknown rootId is a 404; garbage goes to
 * `invalid` and nothing but garbage is a 400; nothing attached means nothing
 * audited; a username link that disagrees with the stored username is judged
 * after getChat.
 *
 * Run: npx tsx scripts/offline/panel-links.mts
 */
import { GrammyError } from 'grammy';
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import { signInitData, type InitDataUserInput } from '../lib/init-data.mts';

const BOT_TOKEN = '123456789:AAFakeOfflineTokenForPanelTests_0123';
const OWNER_ID = 4242;
const BOT_USER_ID = 7777;
const ALICE: InitDataUserInput = { id: 5001, first_name: 'Alice' };
const OWNER: InitDataUserInput = { id: OWNER_ID, first_name: 'Owner' };

const GROUP = -1001000000401;
const GROUP_INTERNAL = 1000000401;
const RENAMED_GROUP = -1001000000402;
const RENAMED_INTERNAL = 1000000402;

process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.BOT_USER_ID = String(BOT_USER_ID);
process.env.DEFAULT_MODEL = 'gemini-4-argon';
delete process.env.ALLOWED_CHAT_IDS;
// No luoxu: a link to a message we do not have is "missing", as in /chat
delete process.env.LUOXU_PREVIEW_URL;

const db = await setupOfflineDb();
const registry = await import('../../src/db/queries/panel-registry.js');
const { BotResponse, ButtonState, MessageLink } = await import('../../src/db/index.js');
const { SettingsAudit } = await import('../../src/db/settingsAuditDTO.js');
const { loadChatSettingsCache } = await import('../../src/services/chat-settings-service.js');
const { attachLinkedConversations } = await import('../../src/reply/commands/chat-command-link.js');
const { parseTelegramMessageLink } = await import('../../src/reply/commands/telegram-message-link.js');
const { createPanelApp } = await import('../../src/panel/app.js');

type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;
type ChatNameLookup = import('../../src/panel/chat-names.js').ChatNameLookup;

const grammyError = (code: number, description: string): GrammyError =>
    new GrammyError(`(${code}: ${description})`, { ok: false, error_code: code, description }, 'getChatMember', {});

const fakeLookup: MembershipLookup = async (_chatId, userId) => {
    if (userId === ALICE.id) return { status: 'member' };
    throw grammyError(400, 'Bad Request: user not found');
};

/** getChat: the renamed group now answers to new_name; every call is counted */
let chatLookups = 0;
let chatLookupFails = false;
const fakeChatLookup: ChatNameLookup = async (chatId) => {
    chatLookups += 1;
    if (chatLookupFails) throw new Error('network down');
    return chatId === RENAMED_GROUP
        ? { type: 'supergroup', title: 'Renamed', username: 'new_name' }
        : { type: 'supergroup', title: 'Links', username: 'link_lab' };
};

const app = createPanelApp({
    botToken: BOT_TOKEN,
    membershipLookup: fakeLookup,
    staticRoot: '/nonexistent-panel-static-root',
    startedAt: new Date('2026-11-07T00:00:00.000Z'),
    version: 'test',
    chatLookup: fakeChatLookup,
});

const postLinks = async (
    chatId: number,
    rootId: number,
    body: unknown,
    user: InitDataUserInput = ALICE
): Promise<{ status: number; body: any }> => {
    const headers = new Headers({
        'X-Init-Data': signInitData({ botToken: BOT_TOKEN, user, authDate: Math.floor(Date.now() / 1000) }),
        'Content-Type': 'application/json',
    });
    const response = await app.request(`/api/chats/${chatId}/conversations/${rootId}/links`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
    return { status: response.status, body: JSON.parse(await response.text()) };
};

const linkAuditCount = (chatId: number): Promise<number> =>
    SettingsAudit.count({ where: { scope: `chat:${chatId}`, key: 'link' } });

// ---- fixtures -------------------------------------------------------------

let nextId = 9000;
const takeId = (): number => (nextId += 1);

const seedMessage = async (chatId: number, replyToId: number | null, text: string, fromBot = false): Promise<number> => {
    const messageId = takeId();
    await db.Message.create({
        chatId,
        messageId,
        fromBotSelf: fromBot,
        userId: fromBot ? BOT_USER_ID : ALICE.id,
        date: new Date(Date.now() - 600_000 + messageId),
        userName: fromBot ? 'Bot' : 'Alice',
        text,
        quoteText: null,
        file: null,
        fileMime: null,
        fileUniqueId: null,
        replyToId,
        chatCommand: null,
        modelParts: null,
        mediaHint: null,
        forwardOrigin: null,
        forwardFromId: null,
        viaBot: null,
        ocrText: null,
    });
    if (fromBot && replyToId !== null) {
        await BotResponse.create({
            messageId,
            chatId,
            userMessageId: replyToId,
            currentVersionIndex: 0,
            versions: JSON.stringify([
                { versionId: 1, createdAt: new Date().toISOString(), messageIds: [messageId], currentMessageId: messageId, text, wasStoppedByUser: false },
            ]),
            buttonState: ButtonState.NONE,
            metadata: JSON.stringify({ model: 'gemini-4-argon', hasImage: false }),
        });
    }
    return messageId;
};

/** A root and one reply under it */
const seedConversation = async (chatId: number, label: string): Promise<{ root: number; reply: number }> => {
    const root = await seedMessage(chatId, null, `${label} root`);
    const reply = await seedMessage(chatId, root, `${label} reply`);
    return { root, reply };
};

const internalLink = (messageId: number, internalId = GROUP_INTERNAL): string => `https://t.me/c/${internalId}/${messageId}`;

await registry.upsertChatNow({ id: GROUP, type: 'supergroup', title: 'Links', username: 'link_lab' });
await registry.upsertChatNow({ id: RENAMED_GROUP, type: 'supergroup', title: 'Renamed', username: 'old_name' });
await loadChatSettingsCache();

const target = await seedConversation(GROUP, 'A');
const targetBot = await seedMessage(GROUP, target.reply, 'A bot', true);
const sourceB = await seedConversation(GROUP, 'B');
const sourceC = await seedConversation(GROUP, 'C');

// ---- cases ----------------------------------------------------------------

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'links are classified as /chat does; the edges hang off the root; the splice is audited',
        body: async () => {
            const audits = await linkAuditCount(GROUP);
            const { status, body } = await postLinks(GROUP, target.root, {
                links: [
                    ` ${internalLink(sourceB.reply)} `,
                    `https://t.me/link_lab/${sourceC.reply}`,
                    'https://t.me/c/999999/5',
                    internalLink(424242),
                    internalLink(targetBot),
                    'not a link',
                ],
            });
            expect(status === 200, `200 (got ${status} ${JSON.stringify(body)})`);
            expect(body.attachedRoots === 2, `two conversations attached (got ${body.attachedRoots})`);
            expect(JSON.stringify(body.foreign) === '[5]', `another chat's link is foreign (got ${JSON.stringify(body.foreign)})`);
            expect(JSON.stringify(body.missing) === '[424242]', `an unknown message is missing (got ${JSON.stringify(body.missing)})`);
            expect(JSON.stringify(body.alreadyInTree) === JSON.stringify([targetBot]), 'a message of this conversation is already in the tree');
            expect(JSON.stringify(body.invalid) === JSON.stringify(['not a link']), `garbage is invalid (got ${JSON.stringify(body.invalid)})`);
            expect(
                typeof body.notice === 'string' &&
                    body.notice.includes('跳过了 1 条别处的链接') &&
                    body.notice.includes('找不到消息 424242') &&
                    body.notice.includes(`消息 ${targetBot} 已经在同一个上下文里`) &&
                    body.notice.includes('有 1 条不是有效的消息链接'),
                `the notice explains every skipped link (got ${body.notice})`
            );

            const edges = await MessageLink.findAll({ where: { chatId: GROUP, sourceMessageId: target.root } });
            const linked = edges.map((edge) => edge.linkedMessageId).sort((a, b) => a - b);
            expect(JSON.stringify(linked) === JSON.stringify([sourceB.root, sourceC.root]), `edges from the root to the other roots (got ${JSON.stringify(linked)})`);

            expect((await linkAuditCount(GROUP)) === audits + 1, 'one audit row');
            const audit = await SettingsAudit.findOne({ where: { scope: `chat:${GROUP}`, key: 'link' }, order: [['id', 'DESC']] });
            const value = JSON.parse(audit?.newValue ?? '{}');
            expect(
                value.rootId === target.root &&
                    value.attachedRoots === 2 &&
                    JSON.stringify(value.linkMessageIds) === JSON.stringify([sourceB.reply, sourceC.reply, 5, 424242, targetBot]),
                `audit value { rootId, linkMessageIds, attachedRoots } (got ${audit?.newValue})`
            );

            const tree = await app.request(`/api/chats/${GROUP}/conversations/${target.root}`, {
                headers: { 'X-Init-Data': signInitData({ botToken: BOT_TOKEN, user: ALICE, authDate: Math.floor(Date.now() / 1000) }) },
            });
            const nodes = JSON.parse(await tree.text()).nodes;
            const spliced = nodes.find((node: any) => node.messageId === sourceB.root);
            expect(spliced?.edge === 'link' && spliced.parentId === target.root, `the spliced conversation hangs under the root (got ${JSON.stringify(spliced)})`);
        },
    },
    {
        name: 'the same links through /chat <link> come out the same',
        body: async () => {
            // Two identical worlds: one spliced from the panel, one by a /chat command
            const viaPanel = { target: await seedConversation(GROUP, 'P'), other: await seedConversation(GROUP, 'P2') };
            const viaCommand = { target: await seedConversation(GROUP, 'Q'), other: await seedConversation(GROUP, 'Q2') };
            const linksFor = (world: typeof viaPanel): string[] => [
                internalLink(world.other.reply),
                `https://t.me/link_lab/${world.target.reply}`,
                'https://t.me/c/999999/7',
                internalLink(434343),
            ];
            const panel = (await postLinks(GROUP, viaPanel.target.root, { links: linksFor(viaPanel) })).body;

            const commandId = await seedMessage(GROUP, viaCommand.target.reply, '/chat …');
            const parsed = linksFor(viaCommand).flatMap((raw) => {
                const link = parseTelegramMessageLink(raw);
                return link === null ? [] : [link];
            });
            const command = await attachLinkedConversations({ id: GROUP, username: 'link_lab' }, commandId, viaCommand.target.reply, parsed);
            const shape = (result: { attachedRoots: number; foreign: number[]; missing: number[]; alreadyInTree: number[] }): string =>
                JSON.stringify([result.attachedRoots, result.foreign.length, result.missing.length, result.alreadyInTree.length]);
            expect(shape(panel) === shape(command) && shape(panel) === '[1,1,1,1]', `same classification (panel ${shape(panel)}, /chat ${shape(command)})`);
        },
    },
    {
        name: 'rootId must be an existing root',
        body: async () => {
            const notRoot = await postLinks(GROUP, target.reply, { links: [internalLink(sourceB.reply)] });
            expect(notRoot.status === 404 && notRoot.body.error?.code === 'not_found', `a reply is not a root (got ${notRoot.status})`);
            const unknown = await postLinks(GROUP, 515151, { links: [internalLink(sourceB.reply)] });
            expect(unknown.status === 404, `an unknown id is a 404 (got ${unknown.status})`);
            expect((await MessageLink.count({ where: { chatId: GROUP, sourceMessageId: target.reply } })) === 0, 'no orphan edge was written');
        },
    },
    {
        name: 'the body: 1–20 strings, at least one of them a message link',
        body: async () => {
            const garbage = await postLinks(GROUP, target.root, { links: ['nope', 'https://example.com/1'] });
            expect(garbage.status === 400 && garbage.body.error?.code === 'invalid', `nothing but garbage is a 400 (got ${garbage.status})`);
            expect((await postLinks(GROUP, target.root, { links: [] })).status === 400, 'no links is a 400');
            const tooMany = Array.from({ length: 21 }, (_unused, index) => internalLink(index + 1));
            expect((await postLinks(GROUP, target.root, { links: tooMany })).status === 400, '21 links is a 400');
            expect((await postLinks(GROUP, target.root, { links: [42] })).status === 400, 'a non-string is a 400');
            expect((await postLinks(GROUP, target.root, { links: [internalLink(1)], extra: true })).status === 400, 'an unknown key is a 400');
        },
    },
    {
        name: 'nothing attached, nothing audited',
        body: async () => {
            const audits = await linkAuditCount(GROUP);
            const { status, body } = await postLinks(GROUP, target.root, { links: [internalLink(target.reply)] });
            expect(status === 200 && body.attachedRoots === 0 && body.alreadyInTree.length === 1, `already in the tree (got ${JSON.stringify(body)})`);
            expect((await linkAuditCount(GROUP)) === audits, 'no audit row');
        },
    },
    {
        name: 'a username link that disagrees with the stored username is judged after getChat',
        body: async () => {
            const renamedTarget = await seedConversation(RENAMED_GROUP, 'R');
            const renamedSource = await seedConversation(RENAMED_GROUP, 'S');

            chatLookups = 0;
            const viaInternal = await postLinks(RENAMED_GROUP, renamedTarget.root, { links: [internalLink(renamedSource.reply, RENAMED_INTERNAL)] });
            expect(viaInternal.body.attachedRoots === 1 && chatLookups === 0, `an internal link needs no getChat (got ${chatLookups} calls)`);

            const another = await seedConversation(RENAMED_GROUP, 'T');
            const viaNewName = await postLinks(RENAMED_GROUP, renamedTarget.root, { links: [`https://t.me/new_name/${another.reply}`] });
            expect(
                viaNewName.body.attachedRoots === 1 && chatLookups === 1,
                `the new username is confirmed by getChat (got ${JSON.stringify(viaNewName.body)}, ${chatLookups} calls)`
            );

            chatLookupFails = true;
            const yetAnother = await seedConversation(RENAMED_GROUP, 'U');
            const lookupDown = await postLinks(RENAMED_GROUP, renamedTarget.root, { links: [`https://t.me/new_name/${yetAnother.reply}`] });
            chatLookupFails = false;
            expect(
                lookupDown.status === 200 && lookupDown.body.foreign.length === 1,
                `without getChat the stored username decides (got ${JSON.stringify(lookupDown.body)})`
            );
        },
    },
    {
        name: 'observers cannot splice',
        body: async () => {
            const observed = await postLinks(GROUP, target.root, { links: [internalLink(sourceB.reply)] }, OWNER);
            expect(observed.status === 403 && observed.body.error?.code === 'forbidden', `403 (got ${observed.status})`);
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
