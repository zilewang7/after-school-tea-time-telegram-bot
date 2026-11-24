/**
 * Offline integration cases for L2 skill catalog ordering, rich-reply LaTeX
 * dynamic tail injection, and consistency across first reply, retry, and panel
 * model-view (design 2026-1124-2145 §3.1, §3.4.3, §3.8.1).
 *
 * Run: npx tsx scripts/offline/skill-context.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import { createUnusedApi } from './fake-telegram.mts';
import type { UnifiedMessage } from '../../src/ai/types.js';

const BOT_USER_ID = 7777;
const OWNER_ID = 4242;
const MEMBER_ID = 5001;
const GROUP_ENABLED = -1001000000301;
const GROUP_NO_SKILLS = -1001000000302;

process.env.BOT_USER_ID = String(BOT_USER_ID);
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.DEFAULT_MODEL = 'gemini-4-argon';
process.env.TOOL_CHAT_IDS = String(GROUP_ENABLED);
process.env.WORKSPACE_ENABLE = '1';
process.env.WORKSPACE_CHAT_IDS = String(GROUP_ENABLED);
process.env.WIDGET_ENABLE = '1';
process.env.WIDGET_ALLOW_HTML = '1';
process.env.WIDGET_GROUP_FALLBACK = '1';
process.env.WIDGET_CHAT_IDS = String(GROUP_ENABLED);
process.env.SHARE_ENABLED = '1';
process.env.HARNESS_ISSUES = '1';
process.env.LUOXU_PREVIEW_URL = 'http://127.0.0.1:9/luoxu';
process.env.GEMINI_API_KEY = 'offline-placeholder';
process.env.TZ = 'Asia/Shanghai';
delete process.env.SKILLS_ENABLE;
delete process.env.SKILLS_CHAT_IDS;
delete process.env.SKILLS_DIR;
delete process.env.SYSTEM_PROMPT_FILE;

const db = await setupOfflineDb();
const { Message } = db;
const registry = await import('../../src/db/queries/panel-registry.js');
const { loadChatSettingsCache, updateChatSettings } = await import('../../src/services/chat-settings-service.js');
const { writeWorkspaceFile } = await import('../../src/services/workspace-service.js');
const { buildContext } = await import('../../src/reply/context-builder.js');
const { buildStaticSystemPrompt, capabilitiesOf, resolveRuntimeTraits } = await import('../../src/ai/index.js');
const { buildStaticPromptOptions } = await import('../../src/reply/static-prompt-options.js');
const { buildReplyToolContext } = await import('../../src/reply/tools/reply-tool-context.js');
const { createReplyTools } = await import('../../src/reply/tools/create-reply-tools.js');
const { getSkillRegistry } = await import('../../src/reply/skills/skill-registry.js');
const { buildSkillCatalogSection } = await import('../../src/reply/skills/skill-catalog-tail.js');
const { createWorkspaceState } = await import('../../src/reply/workspace/workspace-state.js');
const { appendWorkspaceTailForReply, RICH_INLINE_TAIL, RICH_LATEX_TAIL } = await import(
    '../../src/reply/workspace/workspace-tail.js'
);
const { buildModelView } = await import('../../src/panel/views/model-view.js');
const { countCodePoints } = await import('../../src/shared/code-points.js');
const { sequelize } = await import('../../src/db/config.js');

const MODEL = 'gemini-4-argon';
const QUOTA = {
    maxFileBytes: 4096,
    maxConversationBytes: 12_000,
    maxFiles: 5,
    maxGlobalBytes: 1_000_000,
};

const TIME_LINE = /^- 当前时间：\d{4}\/\d{2}\/\d{2} \d{2}:\d{2} \S+（[^）]+）$/m;
const normalizeTime = (text: string): string => text.replace(TIME_LINE, '- 当前时间：2026/11/24 22:00 周二（Asia/Shanghai）');

const wireOf = (messages: readonly UnifiedMessage[], index: number): string =>
    (messages[index]?.content ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('');

const turnTextsOf = (view: Awaited<ReturnType<typeof buildModelView>>): string[] =>
    view.turns.flatMap((turn) => turn.parts.filter((part) => part.type === 'text').map((part) => part.text ?? ''));

await registry.upsertChatNow({ id: GROUP_ENABLED, type: 'supergroup', title: 'Skills Enabled Group' });
await registry.upsertChatNow({ id: GROUP_NO_SKILLS, type: 'supergroup', title: 'No Skills Group' });
await loadChatSettingsCache();

const cases: CaseResult[] = [];

cases.push(
    await runCase('appendWorkspaceTailForReply places skill catalog strictly before workspace manifest', async () => {
        const rootId = takeMessageId();
        await writeWorkspaceFile({
            chatId: GROUP_ENABLED,
            conversationRootId: rootId,
            path: 'notes/draft.md',
            content: '# 草稿',
            append: false,
            overwrite: true,
            quota: QUOTA,
        });
        await writeWorkspaceFile({
            chatId: GROUP_ENABLED,
            conversationRootId: rootId,
            path: 'handoff.md',
            content: '下一步：检查卡片',
            append: false,
            overwrite: true,
            quota: QUOTA,
        });

        const skills = getSkillRegistry();
        expect(skills.length === 4, `repo ships 4 skills (got ${skills.length})`);
        const messages: UnifiedMessage[] = [{ role: 'user', content: [{ type: 'text', text: '[system] 运行时信息' }] }];
        const state = createWorkspaceState({
            chatId: GROUP_ENABLED,
            conversationRootIds: [rootId],
            quota: QUOTA,
        });

        const tailResult = await appendWorkspaceTailForReply({
            messages,
            triggerTurnIndex: 0,
            workspaceState: state,
            conversationRootIds: [rootId],
            contextIndex: new Map(),
            enabled: true,
            handoff: true,
            fileTools: false,
            widgetTools: true,
            richReplies: true,
            richInlineImages: false,
            availableSkills: skills,
        });

        const expectedSection = buildSkillCatalogSection(skills);
        expect(expectedSection !== null, 'catalog section is non-null');
        expect(
            tailResult.catalogChars === countCodePoints(expectedSection ?? ''),
            `catalogChars matches section code points (got ${tailResult.catalogChars})`
        );

        const wire = wireOf(messages, 0);
        const catalogAt = wire.indexOf('[system] 可用技能');
        const manifestAt = wire.indexOf('[system] 工作区');
        const latexAt = wire.indexOf(RICH_LATEX_TAIL);
        const handoffAt = wire.indexOf('[system] 交接文档');
        expect(
            catalogAt > 0 && manifestAt > catalogAt && latexAt > manifestAt && handoffAt > latexAt,
            `tail order is catalog -> manifest -> rich-latex -> handoff (positions ${catalogAt}/${manifestAt}/${latexAt}/${handoffAt})`
        );
        expect(!wire.includes('\n\n\n'), 'sections stay separated by single blank lines');
    })
);

cases.push(
    await runCase('zero available skills omits the catalog completely without affecting other tail sections', async () => {
        const rootId = takeMessageId();
        const state = createWorkspaceState({
            chatId: GROUP_ENABLED,
            conversationRootIds: [rootId],
            quota: QUOTA,
        });

        const emptyMessages: UnifiedMessage[] = [{ role: 'user', content: [{ type: 'text', text: '普通消息' }] }];
        const emptyResult = await appendWorkspaceTailForReply({
            messages: emptyMessages,
            triggerTurnIndex: 0,
            workspaceState: state,
            conversationRootIds: [rootId],
            contextIndex: new Map(),
            enabled: true,
            handoff: false,
            fileTools: false,
            widgetTools: false,
            availableSkills: [],
        });
        expect(emptyResult.catalogChars === 0, 'empty availableSkills yields catalogChars=0');
        expect(!wireOf(emptyMessages, 0).includes('[system] 可用技能'), 'no catalog section with []');

        const omittedMessages: UnifiedMessage[] = [{ role: 'user', content: [{ type: 'text', text: '普通消息' }] }];
        const omittedResult = await appendWorkspaceTailForReply({
            messages: omittedMessages,
            triggerTurnIndex: 0,
            workspaceState: state,
            conversationRootIds: [rootId],
            contextIndex: new Map(),
            enabled: false,
            handoff: false,
            fileTools: false,
            widgetTools: false,
        });
        expect(omittedResult.catalogChars === 0, 'omitted availableSkills yields catalogChars=0');
        expect(wireOf(omittedMessages, 0) === '普通消息', 'nothing appended when all tail features are off');
    })
);

cases.push(
    await runCase('richReplies=true injects dynamic LaTeX tail; richReplies=false does not', async () => {
        const rootId = takeMessageId();
        const state = createWorkspaceState({
            chatId: GROUP_ENABLED,
            conversationRootIds: [rootId],
            quota: QUOTA,
        });

        const richOnlyMessages: UnifiedMessage[] = [{ role: 'user', content: [{ type: 'text', text: '算一下积分' }] }];
        await appendWorkspaceTailForReply({
            messages: richOnlyMessages,
            triggerTurnIndex: 0,
            workspaceState: state,
            conversationRootIds: [rootId],
            contextIndex: new Map(),
            enabled: false,
            handoff: false,
            fileTools: false,
            widgetTools: false,
            richReplies: true,
            richInlineImages: false,
        });
        const richWire = wireOf(richOnlyMessages, 0);
        expect(richWire.includes(RICH_LATEX_TAIL), 'richReplies=true injects RICH_LATEX_TAIL even without workspace or send_image');
        expect(richWire.includes('$…$') && richWire.includes('$$…$$'), 'LaTeX tail names supported delimiters');
        expect(!richWire.includes(RICH_INLINE_TAIL), 'RICH_INLINE_TAIL stays absent when richInlineImages is false');

        const richWithImagesMessages: UnifiedMessage[] = [{ role: 'user', content: [{ type: 'text', text: '带图公式' }] }];
        await appendWorkspaceTailForReply({
            messages: richWithImagesMessages,
            triggerTurnIndex: 0,
            workspaceState: state,
            conversationRootIds: [rootId],
            contextIndex: new Map(),
            enabled: false,
            handoff: false,
            fileTools: false,
            widgetTools: false,
            richReplies: true,
            richInlineImages: true,
        });
        const bothWire = wireOf(richWithImagesMessages, 0);
        expect(bothWire.includes(RICH_LATEX_TAIL) && bothWire.includes(RICH_INLINE_TAIL), 'both rich tails coexist');
        expect(
            bothWire.indexOf(RICH_LATEX_TAIL) < bothWire.indexOf(RICH_INLINE_TAIL),
            'LaTeX note precedes inline-picture note'
        );

        const plainMessages: UnifiedMessage[] = [{ role: 'user', content: [{ type: 'text', text: '普通模式' }] }];
        await appendWorkspaceTailForReply({
            messages: plainMessages,
            triggerTurnIndex: 0,
            workspaceState: state,
            conversationRootIds: [rootId],
            contextIndex: new Map(),
            enabled: false,
            handoff: false,
            fileTools: false,
            widgetTools: false,
            richReplies: false,
            richInlineImages: false,
        });
        expect(!wireOf(plainMessages, 0).includes(RICH_LATEX_TAIL), 'richReplies=false injects no LaTeX tail');
    })
);

cases.push(
    await runCase('panel model-view matches reply/retry tail and keeps static head invariant across richReplies', async () => {
        const rootId = takeMessageId();
        await Message.create({
            chatId: GROUP_ENABLED,
            messageId: rootId,
            fromBotSelf: false,
            userId: MEMBER_ID,
            date: new Date('2026-11-24T12:00:00.000Z'),
            userName: 'Alice',
            text: '画个卡片并推导一下公式',
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
        });
        await writeWorkspaceFile({
            chatId: GROUP_ENABLED,
            conversationRootId: rootId,
            path: 'widgets/calc.html',
            content: '<div>calc</div>',
            append: false,
            overwrite: true,
            quota: QUOTA,
        });

        const chatRow = await registry.findChat(GROUP_ENABLED);
        if (chatRow === null) throw new Error('GROUP_ENABLED missing from panel registry');

        // Plain mode: catalog before manifest, no LaTeX tail
        await updateChatSettings({
            chatId: GROUP_ENABLED,
            patch: { richReplies: false, toolOverrides: null },
            actor: { userId: OWNER_ID, isOwner: true },
        });
        const plainView = await buildModelView({
            chat: chatRow,
            rootId,
            at: rootId,
            asModel: undefined,
            toolApi: createUnusedApi(),
            now: new Date('2026-11-24T12:01:00.000Z'),
        });
        expect(plainView.tools.includes('load_skill'), 'model-view declares load_skill when skills are available');
        const plainTriggerWire = (plainView.turns.at(-1)?.parts ?? [])
            .filter((part) => part.type === 'text')
            .map((part) => part.text ?? '')
            .join('');
        expect(
            plainTriggerWire.includes('[system] 可用技能') && plainTriggerWire.includes('[system] 工作区'),
            'plain model-view includes skill catalog and workspace manifest'
        );
        expect(
            plainTriggerWire.indexOf('[system] 可用技能') < plainTriggerWire.indexOf('[system] 工作区'),
            'model-view puts skill catalog before workspace manifest'
        );
        expect(!plainTriggerWire.includes(RICH_LATEX_TAIL), 'plain model-view omits LaTeX tail');

        // Rich mode: identical static head, LaTeX tail injected, matches reply/retry builder
        await updateChatSettings({
            chatId: GROUP_ENABLED,
            patch: { richReplies: true },
            actor: { userId: OWNER_ID, isOwner: true },
        });
        const richView = await buildModelView({
            chat: chatRow,
            rootId,
            at: rootId,
            asModel: undefined,
            toolApi: createUnusedApi(),
            now: new Date('2026-11-24T12:01:00.000Z'),
        });
        expect(
            richView.systemPrompt === plainView.systemPrompt,
            'richReplies toggle keeps static systemPrompt byte-identical'
        );

        const triggerRow = await Message.findOne({ where: { chatId: GROUP_ENABLED, messageId: rootId } });
        if (triggerRow === null) throw new Error('trigger row missing');
        const capabilities = capabilitiesOf(resolveRuntimeTraits(MODEL));
        const built = await buildContext(triggerRow, {
            capabilities,
            model: MODEL,
            chatTitle: chatRow.title ?? undefined,
            chatAddendum: null,
            dryRun: true,
        });
        const { tools, availability, workspaceState, availableSkills } = createReplyTools(
            MODEL,
            buildReplyToolContext({
                chat: { id: GROUP_ENABLED, type: 'supergroup', title: chatRow.title ?? 'Skills Enabled Group' },
                triggerMessage: triggerRow,
                contextIndex: built.contextIndex,
                conversationRootIds: built.conversationRootIds,
                signal: new AbortController().signal,
                api: createUnusedApi(),
            }),
            null,
            'full',
            undefined,
            capabilities
        );
        await appendWorkspaceTailForReply({
            messages: built.messages,
            triggerTurnIndex: built.triggerTurnIndex,
            workspaceState,
            conversationRootIds: built.conversationRootIds,
            contextIndex: built.contextIndex,
            enabled: availability.workspace,
            handoff: availability.handoff,
            fileTools: availability.file,
            widgetTools: availability.widget,
            richInlineImages: availability.sendImage,
            richReplies: true,
            availableSkills,
        });
        const replyHead = buildStaticSystemPrompt(MODEL, buildStaticPromptOptions(availability), capabilities);
        expect(richView.systemPrompt === replyHead, 'model-view static head matches reply/retry');
        expect(
            JSON.stringify(richView.tools) === JSON.stringify(tools.definitions.map((definition) => definition.name)),
            'model-view tool list matches createReplyTools'
        );
        const richViewTriggerWire = (richView.turns.at(-1)?.parts ?? [])
            .filter((part) => part.type === 'text')
            .map((part) => part.text ?? '')
            .join('');
        const replyTriggerWire = wireOf(built.messages, built.triggerTurnIndex);
        expect(
            normalizeTime(richViewTriggerWire) === normalizeTime(replyTriggerWire),
            'model-view trigger turn (including catalog, manifest, and rich LaTeX tail) matches reply/retry'
        );

        // Panel skills override off: load_skill and catalog both vanish
        await updateChatSettings({
            chatId: GROUP_ENABLED,
            patch: { toolOverrides: { skills: false } },
            actor: { userId: OWNER_ID, isOwner: true },
        });
        const noSkillView = await buildModelView({
            chat: chatRow,
            rootId,
            at: rootId,
            asModel: undefined,
            toolApi: createUnusedApi(),
            now: new Date('2026-11-24T12:01:00.000Z'),
        });
        expect(!noSkillView.tools.includes('load_skill'), 'skills=false omits load_skill from model-view');
        expect(
            !turnTextsOf(noSkillView).some((text) => text.includes('[system] 可用技能')),
            'skills=false omits skill catalog from model-view'
        );

        // Chat with zero available skills: load_skill and catalog omitted automatically
        const noSkillRootId = takeMessageId();
        await Message.create({
            chatId: GROUP_NO_SKILLS,
            messageId: noSkillRootId,
            fromBotSelf: false,
            userId: MEMBER_ID,
            date: new Date('2026-11-24T12:00:00.000Z'),
            userName: 'Alice',
            text: '普通群聊消息',
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
        });
        const noSkillChatRow = await registry.findChat(GROUP_NO_SKILLS);
        if (noSkillChatRow === null) throw new Error('GROUP_NO_SKILLS missing from panel registry');
        const zeroSkillView = await buildModelView({
            chat: noSkillChatRow,
            rootId: noSkillRootId,
            at: noSkillRootId,
            asModel: undefined,
            toolApi: createUnusedApi(),
            now: new Date('2026-11-24T12:01:00.000Z'),
        });
        expect(!zeroSkillView.tools.includes('load_skill'), 'zero-skill chat omits load_skill');
        expect(
            !turnTextsOf(zeroSkillView).some((text) => text.includes('[system] 可用技能')),
            'zero-skill chat omits skill catalog'
        );
    })
);

await sequelize.close();
reportResults(cases);
