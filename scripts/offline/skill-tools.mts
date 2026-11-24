/**
 * Offline integration cases for load_skill wiring in createReplyTools:
 * - auto-omission when 0 skills are available & fixed declaration slot when active;
 * - TIME_FREE_TOOL_NAMES and RESERVED_TOOL_NAMES membership + MCP load_skill -> load_skill_2;
 * - SKILLS_ENABLE=0, SKILLS_CHAT_IDS whitelist, DISABLED_TOOLS=load_skill, and panel 'skills' switch;
 * - SkillToolState preserved across ReplyCheckpoint / "继续" and counted by estimateCheckpointBytes.
 *
 * Run: npx tsx scripts/offline/skill-tools.mts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import { createUnusedApi, endOpenReplies } from './fake-telegram.mts';
import { answer } from './support/gemini-loop-fixtures.mts';
import {
    answersIn,
    createResumeBench,
    failingRound,
    FULL_USER_ID,
    quietCase,
    roundOf,
    takeChatId,
} from './support/resume-bench.mts';

const EMPTY_SKILLS_DIR = mkdtempSync(join(tmpdir(), 'k-on-empty-skills-'));
process.once('exit', () => {
    rmSync(EMPTY_SKILLS_DIR, { recursive: true, force: true });
});

// Start a local MCP stub exposing a tool named `load_skill` to verify collision
// renaming before createResumeBench initializes its own MCP server.
const readBody = (request: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

const clashMcpServer = createServer((request, response: ServerResponse) => {
    if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
    }
    void readBody(request).then((body) => {
        const message = asRecord(JSON.parse(body || '{}'));
        if (message.id === undefined) {
            response.writeHead(202).end();
            return;
        }
        const method = String(message.method);
        const params = asRecord(message.params);
        if (method === 'initialize') {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(
                JSON.stringify({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: {
                        protocolVersion: params.protocolVersion,
                        capabilities: { tools: {} },
                        serverInfo: { name: 'skill-clash-stub', version: '1.0.0' },
                    },
                })
            );
            return;
        }
        if (method === 'tools/list') {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(
                JSON.stringify({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: {
                        tools: [
                            {
                                name: 'load_skill',
                                description: 'External MCP tool colliding with load_skill',
                                inputSchema: { type: 'object', properties: { topic: { type: 'string' } } },
                            },
                        ],
                    },
                })
            );
            return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } }));
    });
});
await new Promise<void>((ready) => clashMcpServer.listen(0, '127.0.0.1', ready));
const clashPort = (clashMcpServer.address() as AddressInfo).port;
process.env.MCP_SERVERS = JSON.stringify({ clash: { serverUrl: `http://127.0.0.1:${clashPort}/mcp` } });

// Initialize the resume bench first (which sets DB_PATH/env, sets up offline DB,
// and loads src/). Note: createResumeBench overwrites MCP_SERVERS for its own stub,
// so we run the collision check against clashMcpServer via connectMcpServer / buildMcpToolHandlers.
const bench = await createResumeBench();

const { readToolConfig } = await import('../../src/config/tool-config.js');
const { resolveToolAvailability } = await import('../../src/reply/tools/tool-availability.js');
const { createReplyTools } = await import('../../src/reply/tools/create-reply-tools.js');
const { buildReplyToolContext } = await import('../../src/reply/tools/reply-tool-context.js');
const {
    LOAD_SKILL_TOOL_NAME,
    RESERVED_TOOL_NAMES,
    TIME_FREE_TOOL_NAMES,
    isTimeFreeToolName,
} = await import('../../src/reply/tools/tool-names.js');
const { toolTimeSpentMs } = await import('../../src/ai/tools/tool-round.js');
const { resetSkillRegistryCache } = await import('../../src/reply/skills/skill-registry.js');
const { buildMcpToolHandlers } = await import('../../src/ai/tools/mcp-tool-handlers.js');
const { toToolName } = await import('../../src/ai/tools/tool-wire-formats.js');
const { normalizeToolOverrides } = await import('../../src/services/tool-overrides.js');
const { buildToolMatrix } = await import('../../src/panel/views/tool-matrix.js');
const { estimateCheckpointBytes } = await import('../../src/reply/resume/checkpoint-size.js');
const { createReplyToolState } = await import('../../src/reply/tools/reply-tool-state.js');
const mcp = await import('../../src/ai/mcp/index.js');

const ACTIVE_CHAT_ID = takeChatId();
const NO_TOOLS_CHAT_ID = -1009991112223;
const MODEL = 'gemini-4-argon';

const makeContext = (chatId: number) =>
    buildReplyToolContext({
        chat: { id: chatId, type: 'supergroup', title: 'Skill Tools Lab' },
        triggerMessage: { messageId: 1, userId: FULL_USER_ID, userName: 'Alice', text: 'test' },
        contextIndex: new Map(),
        conversationRootIds: [1],
        signal: new AbortController().signal,
        api: createUnusedApi(),
    });

const cases: CaseResult[] = [];

cases.push(
    await runCase('load_skill is in TIME_FREE_TOOL_NAMES and RESERVED_TOOL_NAMES, and MCP collision renames to load_skill_2', async () => {
        expect(TIME_FREE_TOOL_NAMES.has(LOAD_SKILL_TOOL_NAME), 'load_skill is in TIME_FREE_TOOL_NAMES');
        expect(isTimeFreeToolName(LOAD_SKILL_TOOL_NAME), 'isTimeFreeToolName recognizes load_skill');
        expect(RESERVED_TOOL_NAMES.includes(LOAD_SKILL_TOOL_NAME), 'load_skill is in RESERVED_TOOL_NAMES');

        const charged = toolTimeSpentMs([
            {
                call: { id: '1', name: 'load_skill', argumentsJson: '{"names":["widget-a2ui"]}' },
                result: { content: 'ok', isError: false, images: [], record: null },
                durationMs: 750,
            },
            {
                call: { id: '2', name: 'history', argumentsJson: '{"action":"search"}' },
                result: { content: 'ok', isError: false, images: [], record: null },
                durationMs: 900,
            },
        ]);
        expect(charged === 900, `load_skill does not consume tool clock (got ${charged}ms)`);

        expect(
            toToolName('load_skill', new Set(RESERVED_TOOL_NAMES)) === 'load_skill_2',
            'toToolName renames colliding load_skill to load_skill_2'
        );

        // Verify against a real connected MCP server that exposes `load_skill`
        await mcp.shutdownMcp();
        process.env.MCP_SERVERS = JSON.stringify({ clash: { serverUrl: `http://127.0.0.1:${clashPort}/mcp` } });
        await mcp.initMcpClients();
        try {
            const mcpHandlers = buildMcpToolHandlers(['clash'], RESERVED_TOOL_NAMES);
            expect(
                mcpHandlers.map((handler) => handler.definition.name).join(',') === 'load_skill_2',
                `buildMcpToolHandlers renames MCP load_skill to load_skill_2 (got ${mcpHandlers.map((h) => h.definition.name).join(',')})`
            );

            // Through real createReplyTools: both active and 0-skill chats keep load_skill_2
            const withSkills = createReplyTools(MODEL, makeContext(ACTIVE_CHAT_ID), null, 'full');
            const withSkillNames = withSkills.tools.definitions.map((definition) => definition.name);
            expect(
                withSkillNames.includes('load_skill_2') && withSkillNames.includes('load_skill'),
                `active chat keeps MCP load_skill_2 alongside built-in load_skill (${withSkillNames.join(',')})`
            );

            const withoutSkills = createReplyTools(MODEL, makeContext(NO_TOOLS_CHAT_ID), null, 'full');
            const withoutSkillNames = withoutSkills.tools.definitions.map((definition) => definition.name);
            expect(
                withoutSkillNames.includes('load_skill_2') && !withoutSkillNames.includes('load_skill'),
                `zero-skill chat keeps MCP load_skill_2 and omits built-in load_skill (${withoutSkillNames.join(',')})`
            );
        } finally {
            await mcp.shutdownMcp();
            clashMcpServer.closeAllConnections();
            await new Promise<void>((closed) => clashMcpServer.close(() => closed()));
        }
    })
);

cases.push(
    await runCase('createReplyTools omits load_skill at 0 skills and keeps its fixed slot when active', async () => {
        const activeTurn = createReplyTools(MODEL, makeContext(ACTIVE_CHAT_ID), null, 'full');
        const activeNames = activeTurn.tools.definitions.map((definition) => definition.name);
        expect(activeTurn.availableSkills.length === 4, `all 4 skills available (got ${activeTurn.availableSkills.length})`);
        const widgetIdx = activeNames.indexOf('send_widget');
        const skillIdx = activeNames.indexOf('load_skill');
        const workspaceIdx = activeNames.indexOf('workspace');
        expect(
            widgetIdx >= 0 && skillIdx === widgetIdx + 1 && workspaceIdx === skillIdx + 1,
            `load_skill sits right between send_widget and workspace (${activeNames.join(',')})`
        );

        // Turning off widget/workspace/harnessIssues leaves 0 matching skills -> load_skill omitted
        const gatedOut = createReplyTools(
            MODEL,
            makeContext(ACTIVE_CHAT_ID),
            { widget: false, workspace: false, harnessIssues: false },
            'full'
        );
        expect(gatedOut.availableSkills.length === 0, 'no skills pass gating when dependent tools are off');
        expect(
            !gatedOut.tools.definitions.some((definition) => definition.name === 'load_skill'),
            'load_skill declaration is omitted when 0 skills match gating'
        );

        // A chat outside TOOL_CHAT_IDS gets 0 skills -> load_skill omitted
        const plainChat = createReplyTools(MODEL, makeContext(NO_TOOLS_CHAT_ID), null, 'full');
        expect(plainChat.availableSkills.length === 0, 'non-whitelisted chat has 0 available skills');
        expect(
            !plainChat.tools.definitions.some((definition) => definition.name === 'load_skill'),
            'load_skill is omitted on a chat with 0 skills'
        );

        // Empty SKILLS_DIR even with widget/workspace/harnessIssues enabled -> load_skill omitted
        const prevSkillsDir = process.env.SKILLS_DIR;
        process.env.SKILLS_DIR = EMPTY_SKILLS_DIR;
        resetSkillRegistryCache();
        try {
            const emptyDirTurn = createReplyTools(MODEL, makeContext(ACTIVE_CHAT_ID), null, 'full');
            expect(emptyDirTurn.availableSkills.length === 0, 'empty SKILLS_DIR yields 0 skills');
            expect(
                !emptyDirTurn.tools.definitions.some((definition) => definition.name === 'load_skill'),
                'load_skill is omitted when SKILLS_DIR has 0 skills'
            );
        } finally {
            if (prevSkillsDir === undefined) delete process.env.SKILLS_DIR;
            else process.env.SKILLS_DIR = prevSkillsDir;
            resetSkillRegistryCache();
        }
    })
);

cases.push(
    await runCase('SKILLS_ENABLE=0, SKILLS_CHAT_IDS, DISABLED_TOOLS=load_skill, and panel skills switch take effect', async () => {
        const baseEnv = {
            TOOL_CHAT_IDS: String(ACTIVE_CHAT_ID),
            WIDGET_ENABLE: '1',
            WIDGET_GROUP_FALLBACK: '1',
            SHARE_ENABLED: '1',
            WORKSPACE_ENABLE: '1',
        };

        // Default: SKILLS_ENABLE unset & SKILLS_CHAT_IDS empty -> enabled for all chats
        const defaultConfig = readToolConfig(baseEnv);
        expect(defaultConfig.skillsEnabled === true, 'skillsEnabled defaults to true');
        expect(defaultConfig.skillsChatIds === null, 'empty SKILLS_CHAT_IDS means null (no whitelist restriction)');
        expect(resolveToolAvailability(MODEL, ACTIVE_CHAT_ID, defaultConfig).skills === true, 'active chat gets skills');
        expect(resolveToolAvailability(MODEL, NO_TOOLS_CHAT_ID, defaultConfig).skills === true, 'unlisted chat also gets skills permission by default');

        // SKILLS_ENABLE=0 kills skills even with panel override true
        const killConfig = readToolConfig({ ...baseEnv, SKILLS_ENABLE: '0' });
        expect(killConfig.skillsEnabled === false, 'SKILLS_ENABLE=0 disables skillsEnabled');
        expect(
            resolveToolAvailability(MODEL, ACTIVE_CHAT_ID, killConfig, { skills: true }).skills === false,
            'SKILLS_ENABLE=0 cannot be overridden by panel'
        );

        // SKILLS_CHAT_IDS whitelist restricts non-listed chats, and panel override can override whitelist
        const whitelistConfig = readToolConfig({ ...baseEnv, SKILLS_CHAT_IDS: String(ACTIVE_CHAT_ID) });
        expect(resolveToolAvailability(MODEL, ACTIVE_CHAT_ID, whitelistConfig).skills === true, 'whitelisted chat allowed');
        expect(resolveToolAvailability(MODEL, NO_TOOLS_CHAT_ID, whitelistConfig).skills === false, 'non-whitelisted chat blocked');
        expect(
            resolveToolAvailability(MODEL, NO_TOOLS_CHAT_ID, whitelistConfig, { skills: true }).skills === true,
            'panel skills=true overrides SKILLS_CHAT_IDS whitelist'
        );

        // DISABLED_TOOLS=load_skill turns off both skills and widget
        const disabledConfig = readToolConfig({ ...baseEnv, DISABLED_TOOLS: 'load_skill' });
        const disabledAvail = resolveToolAvailability(MODEL, ACTIVE_CHAT_ID, disabledConfig);
        expect(!disabledAvail.skills && !disabledAvail.widget, 'DISABLED_TOOLS=load_skill disables both skills and widget');

        // Panel 'skills' switch in normalizeToolOverrides, createReplyTools, and buildToolMatrix
        const normalizedOff = normalizeToolOverrides({ skills: false });
        expect(normalizedOff.ok && normalizedOff.value?.skills === false, 'panel accepts skills override');
        const panelOffTurn = createReplyTools(
            MODEL,
            makeContext(ACTIVE_CHAT_ID),
            normalizedOff.ok ? normalizedOff.value : null,
            'full'
        );
        expect(!panelOffTurn.availability.skills, 'skills override=false disables availability.skills');
        expect(panelOffTurn.availableSkills.length === 0, 'skills override=false yields 0 availableSkills');
        expect(
            !panelOffTurn.tools.definitions.some((definition) => definition.name === 'load_skill'),
            'skills override=false omits load_skill from createReplyTools'
        );

        const matrix = buildToolMatrix(MODEL, ACTIVE_CHAT_ID, { skills: false }, 'full');
        const skillsGroup = matrix.find((entry) => entry.key === 'skills');
        expect(
            skillsGroup !== undefined &&
                skillsGroup.tools.join(',') === 'load_skill' &&
                skillsGroup.enabled === false &&
                skillsGroup.override === false &&
                skillsGroup.blocked === false,
            `tool-matrix reports skills group accurately (got ${JSON.stringify(skillsGroup)})`
        );
    })
);

cases.push(
    await runCase('estimateCheckpointBytes counts SkillToolState loadedNames', async () => {
        const emptyState = createReplyToolState({ chatId: ACTIVE_CHAT_ID, conversationRootIds: [1] });
        const loadedState = createReplyToolState({ chatId: ACTIVE_CHAT_ID, conversationRootIds: [1] });
        loadedState.skills.markLoaded('widget-a2ui');
        loadedState.skills.markLoaded('widget-html');
        loadedState.skills.markLoaded('workspace-usage');

        const makeDummyCheckpoint = (toolState: typeof emptyState) => ({
            chatId: ACTIVE_CHAT_ID,
            firstMessageId: 100,
            userMessageId: 99,
            failedVersionId: 1,
            savedAt: Date.now(),
            toolState,
            loop: {
                platform: 'gemini' as const,
                completedRounds: 1,
                toolUsage: [],
                journal: [],
                state: { contents: [] },
            },
            context: {
                numbering: new Map(),
                contextIndex: new Map(),
                conversationRootIds: [1],
                promptAddendum: null,
                promptAddendumCustom: null,
                promptTemplateIds: null,
                promptTemplatesAuto: true,
                builtAt: Date.now(),
                contextMessageIds: [99],
            },
            request: {
                model: MODEL,
                systemPrompt: 'sys',
                toolDefinitionsJson: '[]',
                thinkingEffort: null,
                thinkingEffortSent: null,
            },
        });

        const baseBytes = estimateCheckpointBytes(makeDummyCheckpoint(emptyState));
        const loadedBytes = estimateCheckpointBytes(makeDummyCheckpoint(loadedState));
        expect(
            loadedBytes > baseBytes,
            `loaded skill names increase estimateCheckpointBytes (${baseBytes} -> ${loadedBytes})`
        );

        // Direct carriedToolState reuse preserves SkillToolState
        const resumedTurn = createReplyTools(MODEL, makeContext(ACTIVE_CHAT_ID), null, 'full', loadedState);
        const repeat = await resumedTurn.tools.execute(
            { id: 'c1', name: 'load_skill', argumentsJson: JSON.stringify({ names: ['widget-a2ui'] }) },
            new AbortController().signal
        );
        expect(!repeat.isError && repeat.content.includes('本次回复已加载过'), 'carriedToolState remembers loaded skills');
    })
);

cases.push(
    await runCase(
        'SkillToolState survives ReplyCheckpoint and 继续 in the real Gemini loop',
        quietCase(async () => {
            const { vertex, telegram } = bench;
            const chatId = takeChatId();

            vertex.reset([
                roundOf({
                    label: 'r1',
                    calls: [{ name: 'load_skill', args: { names: ['widget-a2ui'] } }],
                }),
                failingRound(),
            ]);
            telegram.reset();
            const reply = await bench.ask(chatId, '@AfterSchoolTeatimeBot 帮我做一张天气卡片');
            const entry = bench.entryOf(reply);
            expect(entry !== undefined, 'failed reply saved a checkpoint');
            if (entry === undefined) return;
            expect(
                entry.toolState.skills.hasLoaded('widget-a2ui') && entry.toolState.skills.loadedNames.size === 1,
                `checkpoint remembers widget-a2ui (got ${[...entry.toolState.skills.loadedNames].join(',')})`
            );
            expect(estimateCheckpointBytes(entry) > 0, 'estimateCheckpointBytes measures the real checkpoint');

            // After 继续: re-loading widget-a2ui gets the one-line reminder instead of re-pasting,
            // while loading widget-html succeeds as new.
            vertex.reset([
                roundOf({
                    label: 'r2',
                    calls: [{ name: 'load_skill', args: { names: ['widget-a2ui', 'widget-html'] } }],
                }),
                answer('规范已加载。'),
            ]);
            telegram.reset();
            await bench.continueReply(reply);
            const answers = answersIn(vertex.requests[1]);
            const loadAnswer = answers.filter((item) => item.name === 'load_skill').at(-1);
            const text = loadAnswer?.output ?? '';
            expect(
                text.includes('本次回复已加载过 `widget-a2ui`'),
                `after 继续, widget-a2ui is remembered as already loaded (got ${text.slice(0, 200)})`
            );
            expect(
                text.includes('[skill] widget-html v'),
                `after 继续, new skill widget-html still loads its body (got ${text.slice(0, 200)})`
            );
        })
    )
);

await bench.close();
endOpenReplies();
reportResults(cases);
