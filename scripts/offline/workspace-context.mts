/**
 * Offline cases for the workspace's place in the model context — the manifest
 * appended to the trigger message, the conversation roots a reply may address,
 * and the static prompt lines that must only appear with their tools.
 *
 * Run: npx tsx scripts/offline/workspace-context.mts
 *
 * No Telegram, no network: messages are seeded into the scratch database and
 * buildContext is called exactly as the reply path calls it.
 */
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';

// The platform factories construct clients from the env on first use; these
// dummies are never contacted.
process.env.OPENAI_API_KEY ||= 'offline-stub';
process.env.DEEPSEEK_API_KEY ||= 'offline-stub';
process.env.DEEPSEEK_API_URL ||= 'http://127.0.0.1:9/v1';
process.env.GEMINI_API_KEY ||= 'offline-stub';
process.env.GEMINI_API_URL ||= 'http://127.0.0.1:9/v1';
process.env.BOT_USER_ID = '7777';

const db = await setupOfflineDb();
const { Message } = db;
const { buildContext } = await import('../../src/reply/context-builder.js');
const { buildStaticSystemPrompt } = await import('../../src/ai/system-prompt/builder.js');
const { appendWorkspaceManifestForReply } = await import('../../src/reply/workspace/workspace-manifest.js');
const { appendWorkspaceTailForReply } = await import('../../src/reply/workspace/workspace-tail.js');
const { createWorkspaceState } = await import('../../src/reply/workspace/workspace-state.js');
const { writeWorkspaceFile } = await import('../../src/services/workspace-service.js');

const CHAT = -1009999999999;
const ROOT_A = 5000;
const COMMAND = 5001;
const TRIGGER = 5002;
const ROOT_B = 6000;
const QUOTA = {
    maxFileBytes: 4096,
    maxConversationBytes: 12_000,
    maxFiles: 5,
    maxGlobalBytes: 1_000_000,
};

const seedRow = async (fields: Record<string, unknown> & { messageId: number }): Promise<void> => {
    const { messageId, ...overrides } = fields;
    await Message.create({
        chatId: CHAT,
        messageId,
        fromBotSelf: false,
        userId: 1001,
        date: new Date(messageId * 1000),
        userName: 'Alice',
        text: `message ${messageId}`,
        quoteText: null,
        file: null,
        fileMime: null,
        fileUniqueId: null,
        replyToId: null,
        chatCommand: null,
        modelParts: null,
        mediaHint: null,
        forwardOrigin: null,
        forwardFromId: null,
        viaBot: null,
        ocrText: null,
        ...overrides,
    });
};

const rowOf = async (messageId: number) => {
    const row = await Message.findOne({ where: { chatId: CHAT, messageId } });
    if (row === null) throw new Error(`message ${messageId} was not stored`);
    return row;
};

/** The text parts of the message the runtime block was appended to */
const runtimeTurnOf = (messages: readonly { content: readonly { type: string; text?: string }[] }[], index: number) => {
    const message = messages[index];
    if (message === undefined) throw new Error(`no message at index ${index}`);
    return message.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
};

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'the trigger turn index is computed after capability merging',
        body: async () => {
            // Two adjacent user turns: a plain model keeps them apart, a merging
            // one (deepseek-reasoner) concatenates them, so the index differs.
            await seedRow({ messageId: ROOT_A, text: '背景' });
            await seedRow({ messageId: TRIGGER, replyToId: ROOT_A, text: '继续' });

            const plain = await buildContext(await rowOf(TRIGGER), {
                model: 'gemini-3.8-flash',
                dryRun: true,
            });
            expect(plain.conversationRootIds[0] === ROOT_A, `the root is the conversation (got ${plain.conversationRootIds[0]})`);
            const plainTurn = runtimeTurnOf(plain.messages, plain.triggerTurnIndex);
            expect(plainTurn.includes('运行时信息'), 'the trigger turn carries the runtime block');

            const merged = await buildContext(await rowOf(TRIGGER), {
                model: 'deepseek-reasoner',
                dryRun: true,
            });
            const mergedTurn = runtimeTurnOf(merged.messages, merged.triggerTurnIndex);
            expect(mergedTurn.includes('运行时信息'), 'the merged trigger turn still carries the runtime block');
            expect(
                merged.messages.length <= plain.messages.length,
                `merging never grows the array (plain ${plain.messages.length}, merged ${merged.messages.length})`
            );
        },
    },
    {
        name: 'a /chat splice adds the other conversation as an addressable workspace root',
        body: async () => {
            await seedRow({ messageId: ROOT_B, text: '另一段对话的开头' });
            await seedRow({ messageId: ROOT_A, text: '本对话开头' });
            await seedRow({ messageId: COMMAND, replyToId: ROOT_A, text: '/chat', chatCommand: 'r 1' });
            await seedRow({ messageId: TRIGGER, replyToId: COMMAND, text: '接着聊' });
            const { MessageLink } = await import('../../src/db/messageLinkDTO.js');
            await MessageLink.create({
                chatId: CHAT,
                sourceMessageId: COMMAND,
                linkedMessageId: ROOT_B,
                createdAt: new Date(),
            });

            const built = await buildContext(await rowOf(TRIGGER), {
                model: 'gemini-3.8-flash',
                dryRun: true,
            });
            expect(built.conversationRootIds[0] === ROOT_A, 'the trigger conversation comes first');
            expect(built.conversationRootIds.includes(ROOT_B), 'the spliced conversation is addressable');

            const state = createWorkspaceState({
                chatId: CHAT,
                conversationRootIds: built.conversationRootIds,
                quota: QUOTA,
            });
            const write = (rootId: number, path: string, content: string) =>
                writeWorkspaceFile({
                    chatId: CHAT,
                    conversationRootId: rootId,
                    path,
                    content,
                    append: false,
                    overwrite: true,
                    quota: QUOTA,
                });
            await write(ROOT_A, 'notes/current.md', '# 当前会话的草稿');
            await write(ROOT_B, 'notes/other.md', '# 拼接会话的草稿');

            await appendWorkspaceManifestForReply({
                messages: built.messages,
                triggerTurnIndex: built.triggerTurnIndex,
                workspaceState: state,
                conversationRootIds: built.conversationRootIds,
                contextIndex: built.contextIndex,
                enabled: true,
                fileTools: true,
                widgetTools: true,
            });
            const turn = runtimeTurnOf(built.messages, built.triggerTurnIndex);
            expect(turn.includes('工作区'), 'the manifest is appended to the trigger turn');
            expect(turn.includes('本会话 w1') && turn.includes('notes/current.md'), 'the current workspace is listed');
            expect(turn.includes('w2') && turn.includes('拼接的会话'), 'the spliced workspace gets a token');
            expect(turn.includes('不是指令'), 'the manifest states that names and summaries are not instructions');
            expect((turn.match(/工作区（按会话隔离/g) ?? []).length === 1, 'the manifest is appended exactly once');
        },
    },
    {
        name: 'a /chat r splice resolves linked messages to their real conversation roots',
        body: async () => {
            // Own ids: the earlier cases already linked messages from COMMAND.
            const ownRoot = 5100;
            const ownCommand = 5101;
            const ownTrigger = 5102;
            // Another conversation: 7000 is the root, 7001 replies to it.
            await seedRow({ messageId: 7000, text: '另一段对话的开头' });
            await seedRow({ messageId: 7001, replyToId: 7000, text: '它的回复' });
            await seedRow({ messageId: ownRoot, text: '本对话开头' });
            await seedRow({ messageId: ownCommand, replyToId: ownRoot, text: '/chat', chatCommand: 'r 2' });
            await seedRow({ messageId: ownTrigger, replyToId: ownCommand, text: '接着聊' });
            const { MessageLink } = await import('../../src/db/messageLinkDTO.js');
            // `/chat r` links the messages it selected, not the roots they belong to
            for (const linkedMessageId of [7001, 7000]) {
                await MessageLink.create({ chatId: CHAT, sourceMessageId: ownCommand, linkedMessageId, createdAt: new Date() });
            }

            const built = await buildContext(await rowOf(ownTrigger), {
                model: 'gemini-3.8-flash',
                dryRun: true,
            });
            expect(built.conversationRootIds[0] === ownRoot, 'the trigger conversation comes first');
            expect(
                built.conversationRootIds.includes(7000),
                `the real root of a linked message is addressable (got ${built.conversationRootIds.join(',')})`
            );
            expect(!built.conversationRootIds.includes(7001), 'a linked message id is not mistaken for a root');
            expect(built.conversationRootIds.length === 2, 'both linked ids resolve to one conversation');
        },
    },
    {
        name: 'a linked message resolves through a bot continuation to the real conversation root',
        body: async () => {
            const ownRoot = 5200;
            const ownCommand = 5201;
            const ownTrigger = 5202;
            // Another conversation: user 9000 -> bot reply (first chunk 9001, a
            // Message row) with continuation 9002 (only in BotResponse) -> user
            // 9003 replies to the continuation.
            await seedRow({ messageId: 9000, text: '用户的提问' });
            await seedRow({ messageId: 9001, replyToId: 9000, fromBotSelf: true, text: '机器人回复（第一段）' });
            await seedRow({ messageId: 9003, replyToId: 9002, text: '用户追问续条' });
            const { BotResponse, ButtonState } = await import('../../src/db/index.js');
            await BotResponse.create({
                messageId: 9001,
                chatId: CHAT,
                userMessageId: 9000,
                currentVersionIndex: 0,
                versions: JSON.stringify([
                    {
                        versionId: 1,
                        createdAt: new Date().toISOString(),
                        messageIds: [9001, 9002],
                        currentMessageId: 9002,
                        text: '机器人回复',
                        wasStoppedByUser: false,
                    },
                ]),
                buttonState: ButtonState.NONE,
                metadata: JSON.stringify({ model: 'gemini-4-argon', hasImage: false }),
            });
            await seedRow({ messageId: ownRoot, text: '本对话开头' });
            await seedRow({ messageId: ownCommand, replyToId: ownRoot, text: '/chat', chatCommand: 'r 1' });
            await seedRow({ messageId: ownTrigger, replyToId: ownCommand, text: '接着聊' });
            const { MessageLink } = await import('../../src/db/messageLinkDTO.js');
            // Only the child is linked; its parent chain is outside the context.
            await MessageLink.create({
                chatId: CHAT,
                sourceMessageId: ownCommand,
                linkedMessageId: 9003,
                createdAt: new Date(),
            });

            const built = await buildContext(await rowOf(ownTrigger), {
                model: 'gemini-3.8-flash',
                dryRun: true,
            });
            expect(
                built.conversationRootIds.includes(9000),
                `the continuation resolves to the real root (got ${built.conversationRootIds.join(',')})`
            );
            expect(!built.conversationRootIds.includes(9003), 'the linked child is not a root');
            expect(!built.conversationRootIds.includes(9002), 'the BotResponse-only continuation is not a root');
        },
    },
    {
        name: 'a link to a message that no longer exists names no conversation',
        body: async () => {
            const ownRoot = 5300;
            const ownCommand = 5301;
            const ownTrigger = 5302;
            await seedRow({ messageId: ownRoot, text: '本对话开头' });
            await seedRow({ messageId: ownCommand, replyToId: ownRoot, text: '/chat', chatCommand: 'r 1' });
            await seedRow({ messageId: ownTrigger, replyToId: ownCommand, text: '接着聊' });
            const { MessageLink } = await import('../../src/db/messageLinkDTO.js');
            await MessageLink.create({
                chatId: CHAT,
                sourceMessageId: ownCommand,
                linkedMessageId: 999_999,
                createdAt: new Date(),
            });

            const built = await buildContext(await rowOf(ownTrigger), {
                model: 'gemini-3.8-flash',
                dryRun: true,
            });
            expect(
                built.conversationRootIds.length === 1 && built.conversationRootIds[0] === ownRoot,
                `a dead link adds no phantom root (got ${built.conversationRootIds.join(',')})`
            );
        },
    },
    {
        name: 'a disabled workspace injects nothing',
        body: async () => {
            await seedRow({ messageId: ROOT_A, text: '本对话开头' });
            await seedRow({ messageId: TRIGGER, replyToId: ROOT_A, text: '继续' });
            const built = await buildContext(await rowOf(TRIGGER), {
                model: 'gemini-3.8-flash',
                dryRun: true,
            });
            const before = runtimeTurnOf(built.messages, built.triggerTurnIndex);
            const state = createWorkspaceState({
                chatId: CHAT,
                conversationRootIds: built.conversationRootIds,
                quota: QUOTA,
            });
            await appendWorkspaceManifestForReply({
                messages: built.messages,
                triggerTurnIndex: built.triggerTurnIndex,
                workspaceState: state,
                conversationRootIds: built.conversationRootIds,
                contextIndex: built.contextIndex,
                enabled: false,
                fileTools: false,
                widgetTools: false,
            });
            const after = runtimeTurnOf(built.messages, built.triggerTurnIndex);
            expect(before === after, 'the trigger turn is unchanged when the workspace is off');
        },
    },
    {
        name: 'workspace tools follow WORKSPACE_ENABLE, the chat whitelist and DISABLED_TOOLS',
        body: async () => {
            const { readToolConfig } = await import('../../src/config/tool-config.js');
            const { resolveToolAvailability } = await import('../../src/reply/tools/tool-availability.js');
            const base = {
                TOOL_CHAT_IDS: `${CHAT}`,
                WIDGET_RENDER_URL: 'http://127.0.0.1:9',
                DISABLED_TOOLS: '',
            };
            const off = resolveToolAvailability('gemini-3.8-flash', CHAT, readToolConfig(base), undefined, null);
            expect(!off.workspace, 'the workspace is off by default (WIDGET_ENABLE pattern)');

            const on = resolveToolAvailability(
                'gemini-3.8-flash',
                CHAT,
                readToolConfig({ ...base, WORKSPACE_ENABLE: '1' }),
                undefined,
                null
            );
            expect(on.workspace && on.workspacePreview, 'enabled for the whitelisted chat and a vision model');

            const otherChat = resolveToolAvailability(
                'gemini-3.8-flash',
                -1007777777777,
                readToolConfig({ ...base, WORKSPACE_ENABLE: '1' }),
                undefined,
                null
            );
            expect(!otherChat.workspace, 'a chat outside the whitelist gets no workspace tools');

            const textOnly = resolveToolAvailability(
                'deepseek-reasoner',
                CHAT,
                readToolConfig({ ...base, WORKSPACE_ENABLE: '1' }),
                undefined,
                null
            );
            expect(textOnly.workspace && !textOnly.workspacePreview, 'a text-only model gets the file tools but not preview');

            const noRender = resolveToolAvailability(
                'gemini-3.8-flash',
                CHAT,
                readToolConfig({ ...base, WORKSPACE_ENABLE: '1', WIDGET_RENDER_URL: '' }),
                undefined,
                null
            );
            expect(noRender.workspace && !noRender.workspacePreview, 'preview needs the render sidecar');

            const disabledPreview = resolveToolAvailability(
                'gemini-3.8-flash',
                CHAT,
                readToolConfig({ ...base, WORKSPACE_ENABLE: '1', DISABLED_TOOLS: 'workspace_preview' }),
                undefined,
                null
            );
            expect(disabledPreview.workspace && !disabledPreview.workspacePreview, 'DISABLED_TOOLS=workspace_preview is honored');

            const panelOff = resolveToolAvailability(
                'gemini-3.8-flash',
                CHAT,
                readToolConfig({ ...base, WORKSPACE_ENABLE: '1' }),
                undefined,
                { workspace: false }
            );
            expect(!panelOff.workspace, 'the panel switch can turn the group off');

            const panelOn = resolveToolAvailability(
                'gemini-3.8-flash',
                -1007777777777,
                readToolConfig({ ...base, WORKSPACE_ENABLE: '1' }),
                undefined,
                { workspace: true }
            );
            expect(panelOn.workspace, 'the panel switch can turn the group on for another chat');
        },
    },
    {
        name: 'the static prompt names the workspace only when its tools are offered',
        body: async () => {
            const withWorkspace = buildStaticSystemPrompt('gemini-3.8-flash', {
                workspace: true,
                workspacePreview: true,
                fileTools: true,
                widget: true,
            });
            expect(withWorkspace.includes('workspace_write'), 'the workspace tools are named');
            expect(withWorkspace.includes('workspace_find'), 'the find tool is named');
            expect(withWorkspace.includes('workspace_copy'), 'the copy tool is named');
            expect(withWorkspace.includes('workspace_preview'), 'the preview tool is named');
            expect(withWorkspace.includes('workspace_path'), 'send_file names the workspace source');

            const withoutWorkspace = buildStaticSystemPrompt('gemini-3.8-flash', { fileTools: true, widget: true });
            expect(!withoutWorkspace.includes('workspace_write'), 'no workspace line without the tools');
            expect(!withoutWorkspace.includes('workspace_path'), 'send_file does not name workspace_path');

            const workspaceOnly = buildStaticSystemPrompt('gemini-3.8-flash', {
                workspace: true,
                fileTools: false,
                widget: false,
            });
            expect(workspaceOnly.includes('workspace_write'), 'the workspace line still appears');
            expect(!workspaceOnly.includes('`send_file`'), 'a disabled send_file is not named');
            expect(!workspaceOnly.includes('`send_widget`'), 'a disabled send_widget is not named');

            const noPreview = buildStaticSystemPrompt('gemini-3.8-flash', { workspace: true, workspacePreview: false });
            expect(!noPreview.includes('workspace_preview'), 'preview is not named without the tool');
        },
    },
    {
        name: 'the handoff note rides the volatile tail after the manifest, and only when the switch is on',
        body: async () => {
            const handoffRoot = 8100;
            const handoffTrigger = 8101;
            await seedRow({ messageId: handoffRoot, text: '长任务开头' });
            await seedRow({ messageId: handoffTrigger, replyToId: handoffRoot, text: '继续' });
            const built = await buildContext(await rowOf(handoffTrigger), {
                model: 'gemini-3.8-flash',
                dryRun: true,
            });
            const state = createWorkspaceState({
                chatId: CHAT,
                conversationRootIds: built.conversationRootIds,
                quota: QUOTA,
            });
            await writeWorkspaceFile({
                chatId: CHAT,
                conversationRootId: handoffRoot,
                path: 'handoff.md',
                content: '# 交接\n下一步：写第三节',
                append: false,
                overwrite: true,
                quota: QUOTA,
            });

            await appendWorkspaceTailForReply({
                messages: built.messages,
                triggerTurnIndex: built.triggerTurnIndex,
                workspaceState: state,
                conversationRootIds: built.conversationRootIds,
                contextIndex: built.contextIndex,
                enabled: true,
                fileTools: false,
                widgetTools: false,
                handoff: true,
            });
            const texts = (built.messages[built.triggerTurnIndex]?.content ?? [])
                .filter((part) => part.type === 'text')
                .map((part) => part.text ?? '');
            const handoffIndex = texts.findIndex((text) => text.startsWith('[system] 交接文档'));
            const manifestIndex = texts.findIndex((text) => text.startsWith('[system] 工作区'));
            expect(handoffIndex >= 0, 'the note is appended to the trigger turn');
            expect(manifestIndex >= 0 && handoffIndex > manifestIndex, 'the note comes after the manifest');
            expect(texts[handoffIndex]?.includes('下一步：写第三节'), 'the note body is injected');

            const plain = await buildContext(await rowOf(handoffTrigger), {
                model: 'gemini-3.8-flash',
                dryRun: true,
            });
            await appendWorkspaceTailForReply({
                messages: plain.messages,
                triggerTurnIndex: plain.triggerTurnIndex,
                workspaceState: state,
                conversationRootIds: plain.conversationRootIds,
                contextIndex: plain.contextIndex,
                enabled: true,
                fileTools: false,
                widgetTools: false,
                handoff: false,
            });
            const plainTexts = (plain.messages[plain.triggerTurnIndex]?.content ?? [])
                .filter((part) => part.type === 'text')
                .map((part) => part.text ?? '');
            expect(!plainTexts.some((text) => text.startsWith('[system] 交接文档')), 'no note when the switch is off');
        },
    },
];

const results: CaseResult[] = [];
for (const { name, body } of cases) {
    results.push(await runCase(name, body));
}
reportResults(results);
