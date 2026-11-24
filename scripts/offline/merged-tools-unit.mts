/**
 * Offline unit cases for module C/D: dynamic statusText, the 4 merged tool
 * families (`workspace`, `harness_issue`, `history`, `find_image`), T1 schema
 * slimming, 6-platform schema compatibility, and the 16-tool char/tokB budget.
 *
 * Run: pnpm test:offline merged-tools-unit
 */
import type { ToolDefinition, ToolHandler } from '../../src/ai/tools/tool-types.js';
import type { HistoryService } from '../../src/services/luoxu-history-service.js';
import type { ImageSearchOutcome } from '../../src/services/image-search-service.js';
import type { ReverseSearchOutcome } from '../../src/services/image-reverse-search-service.js';
import type { ImageFetchOutcome } from '../../src/services/image-fetch-service.js';
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import { createUnusedApi } from './fake-telegram.mts';

for (const key of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GROK_API_KEY', 'MIMO_API_KEY']) {
    process.env[key] ||= 'offline-placeholder';
}
process.env.OWNER_USER_ID ||= '1';
process.env.OWNER_DISPLAY_NAME ||= '机主';
process.env.OWNER_SHORT_NAME ||= '老大';
process.env.TZ ||= 'Asia/Shanghai';

await setupOfflineDb();

const { createTurnTools } = await import('../../src/ai/tools/turn-tools.js');
const { createToolUsageTally, runToolRound } = await import('../../src/ai/tools/tool-round.js');
const { buildToolCallRecord } = await import('../../src/ai/tools/tool-call-record.js');
const {
    toAnthropicTools,
    toChatCompletionTools,
    toGeminiFunctionDeclarations,
    toResponsesFunctionTools,
} = await import('../../src/ai/tools/tool-wire-formats.js');
const { buildReplyToolContext } = await import('../../src/reply/tools/reply-tool-context.js');
const { createReplyMediaState } = await import('../../src/reply/tools/reply-media-state.js');
const { createWorkspaceState } = await import('../../src/reply/workspace/workspace-state.js');
const { createHistoryState } = await import('../../src/reply/tools/history-state.js');
const { createHarnessIssueState, MAX_HARNESS_ISSUES_PER_REPLY } = await import(
    '../../src/reply/tools/harness-issue-state.js'
);
const {
    FIND_IMAGE_TOOL_NAME,
    HARNESS_ISSUE_TOOL_NAME,
    HISTORY_TOOL_NAME,
    WORKSPACE_TOOL_NAME,
} = await import('../../src/reply/tools/tool-names.js');
const { createWorkspaceTool } = await import('../../src/reply/tools/workspace-tool.js');
const { createHarnessIssueTool } = await import('../../src/reply/tools/harness-issue-tool.js');
const { createHistoryTool } = await import('../../src/reply/tools/history-tool.js');
const { createFindImageTool } = await import('../../src/reply/tools/find-image-tool.js');
const { createFetchImageTool, PRODUCTION_FETCH_DEPENDENCIES } = await import(
    '../../src/reply/tools/fetch-image-tool.js'
);
const { createGenerateImageTool } = await import('../../src/reply/tools/generate-image-tool.js');
const { createCropImageTool } = await import('../../src/reply/tools/crop-image-tool.js');
const { createExtractFramesTool } = await import('../../src/reply/tools/video-frames-tool.js');
const { createSendImageTool } = await import('../../src/reply/tools/send-image-tool.js');
const { createSendStickerTool } = await import('../../src/reply/tools/send-sticker-tool.js');
const { createSendFileTool } = await import('../../src/reply/tools/send-file-tool.js');
const { createSendWidgetTool } = await import('../../src/reply/tools/send-widget-tool.js');
const { createLeaveHandoffTool } = await import('../../src/reply/tools/leave-handoff-tool.js');
const { createReactToMessageTool } = await import('../../src/reply/tools/react-to-message-tool.js');
const { createSendSmsTool } = await import('../../src/reply/tools/send-sms-tool.js');
const { REACTION_EMOJIS } = await import('../../src/shared/reaction-emoji.js');

const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);
const signal = new AbortController().signal;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const propertiesOf = (schema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> =>
    isRecord(schema.properties) ? schema.properties : {};

const stringArrayOf = (value: unknown): readonly string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const CJK_PATTERN = /[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/u;
const countChars = (text: string): number => Array.from(text).length;
const countTokB = (text: string): number => {
    let cjk = 0;
    let other = 0;
    for (const ch of text) {
        if (CJK_PATTERN.test(ch)) cjk += 1;
        else other += 1;
    }
    return Math.round(cjk * 0.72 + other / 3.6);
};

const makeContext = (chatId = -1001234567890) =>
    buildReplyToolContext({
        chat: chatId > 0
            ? { id: chatId, type: 'private', first_name: '张三' }
            : { id: chatId, type: 'supergroup', title: '测试群' },
        triggerMessage: { messageId: 1, userId: 2, userName: '张三', text: null },
        contextIndex: new Map([
            [1, { number: 1, messageId: 1001, text: '图呢', fromBot: false, images: [], imageCount: 0 }],
        ]),
        signal,
        api: createUnusedApi(),
        conversationRootIds: [1],
    });

const makeWebSearch = (): ((opts: { readonly query: string }) => Promise<ImageSearchOutcome>) => async ({ query }) => ({
    ok: true,
    cached: false,
    images: [
        {
            title: `${query}-1`,
            sourcePage: 'https://example.com/1',
            domain: 'example.com',
            imageUrl: 'https://example.com/1.png',
            thumbnailUrl: 'https://example.com/1-t.png',
            width: 800,
            height: 600,
            format: 'png',
            sendKind: 'static',
        },
        {
            title: `${query}-2`,
            sourcePage: 'https://example.com/2',
            domain: 'example.com',
            imageUrl: 'https://example.com/2.png',
            thumbnailUrl: 'https://example.com/2-t.png',
            width: 800,
            height: 600,
            format: 'png',
            sendKind: 'static',
        },
    ],
});

const makeThumbFetch = (): ((url: string) => Promise<ImageFetchOutcome>) => async (url) => ({
    ok: true,
    image: { data: PNG_1X1, mimeType: 'image/png', finalUrl: url },
});

const makeFakeHistoryService = (): HistoryService => ({
    stats: async () => ({
        groups: [{ channelId: 123, name: '测试群', messages: 10, firstTimestamp: 1700000000, lastTimestamp: 1700001000 }],
    }),
    images: async () => ({ images: [], media: null }),
    imageBytes: async () => null,
    findSenders: async () => [{ uid: 2, name: '张三' }],
    search: async () => ({
        groups: new Map([[123, '测试群']]),
        hasMore: false,
        hits: [
            {
                channelId: 123,
                messageId: 501,
                timestamp: 1700000100,
                fromId: 2,
                fromName: '张三',
                html: '第一条记录',
                editedAt: null,
                deletedAt: null,
            },
            {
                channelId: 123,
                messageId: 502,
                timestamp: 1700000200,
                fromId: 2,
                fromName: '张三',
                html: '第二条记录',
                editedAt: null,
                deletedAt: null,
            },
            {
                channelId: 123,
                messageId: 503,
                timestamp: 1700000300,
                fromId: 2,
                fromName: '张三',
                html: '第三条记录',
                editedAt: null,
                deletedAt: null,
            },
        ],
    }),
    messages: async (_channelId, ids) =>
        ids.map((messageId) => ({
            messageId,
            date: 1700000100,
            senderId: 2,
            senderName: '张三',
            senderIsBot: false,
            text: `原文 ${messageId}`,
            entities: [],
            replyToId: null,
            media: null,
            forward: null,
            imageCount: null,
        })),
});

const results: CaseResult[] = [];

results.push(
    await runCase('TurnTools.statusOf supports dynamic statusText, fallbacks, and runToolRound switching', async () => {
        const dynamicHandler: ToolHandler = {
            definition: { name: 'dyn', description: 'd', inputSchema: { type: 'object', properties: {} } },
            statusText: (args) => {
                if (args.boom === true) throw new Error('boom');
                return typeof args.mode === 'string' ? `mode:${args.mode}` : undefined;
            },
            execute: async () => ({ content: 'ok', isError: false, images: [], record: null }),
        };
        const staticHandler: ToolHandler = {
            definition: { name: 'stat', description: 's', inputSchema: { type: 'object', properties: {} } },
            statusText: '静态状态',
            execute: async () => ({ content: 'ok', isError: false, images: [], record: null }),
        };
        const tools = createTurnTools([dynamicHandler, staticHandler]);

        expect(tools.statusOf('stat').text === '静态状态', 'single-arg statusOf keeps working');
        expect(tools.statusOf('dyn', '{"mode":"a"}').text === 'mode:a', 'parses argumentsJson');
        expect(tools.statusOf('dyn').text === '⚙ 正在调用 dyn…', 'omitted argumentsJson falls back when handler returns undefined');
        expect(tools.statusOf('dyn', '{broken').text === '⚙ 正在调用 dyn…', 'invalid JSON falls back cleanly');
        expect(tools.statusOf('dyn', '[1,2]').text === '⚙ 正在调用 dyn…', 'non-object JSON falls back cleanly');
        expect(tools.statusOf('dyn', '{"boom":true}').text === '⚙ 正在调用 dyn…', 'throwing statusText falls back cleanly');

        const statuses: string[] = [];
        for await (const chunk of runToolRound(
            tools,
            [
                { id: '1', name: 'dyn', argumentsJson: '{"mode":"first"}' },
                { id: '2', name: 'dyn', argumentsJson: '{"mode":"second"}' },
            ],
            createToolUsageTally(),
            signal
        )) {
            if (chunk.type === 'status' && chunk.status !== undefined) {
                statuses.push(chunk.status.text);
            }
        }
        expect(statuses.length === 2 && statuses[0] === 'mode:first' && statuses[1] === 'mode:second', 'runToolRound passes call.argumentsJson per call');
    })
);

results.push(
    await runCase('fetch_image statusText distinguishes pure sticker selection from normal/mixed reads', async () => {
        const ctx = makeContext();
        const media = createReplyMediaState();
        const fetchTool = createFetchImageTool({
            state: media,
            dependencies: PRODUCTION_FETCH_DEPENDENCIES,
            sticker: { setName: 'pack', api: ctx.api },
        });
        const tools = createTurnTools([fetchTool]);

        expect(tools.statusOf('fetch_image', '{"sticker":"07"}').text === '🩷 正在挑选贴纸…', 'single sticker -> sticker status');
        expect(tools.statusOf('fetch_image', '{"stickers":["07","08"]}').text === '🩷 正在挑选贴纸…', 'stickers array -> sticker status');
        expect(tools.statusOf('fetch_image', '{"sticker":"07","url":"","search_ids":[]}').text === '🩷 正在挑选贴纸…', 'empty fillers do not override sticker status');
        expect(tools.statusOf('fetch_image', '{"sticker":"07","url":"https://a.com/x.png"}').text === '🖼 正在读图…', 'mixed sticker + url -> normal image status');
        expect(tools.statusOf('fetch_image', '{"sticker":"07","search_ids":["s1"]}').text === '🖼 正在读图…', 'mixed sticker + search_ids -> normal image status');
        expect(tools.statusOf('fetch_image', '{"url":"https://a.com/x.png"}').text === '🖼 正在读图…', 'url read -> normal image status');
        expect(tools.statusOf('fetch_image', '{"stickers":[]}').text === '🖼 正在读图…', 'empty stickers array -> normal image status');
        expect(tools.statusOf('fetch_image', '{"stickers":["  "]}').text === '🖼 正在读图…', 'blank-only stickers -> normal image status');
    })
);

results.push(
    await runCase('workspace 8-in-1 actions, preview pruning, statusText, and trace prefix', async () => {
        const chatId = -100777888999;
        const ws = createWorkspaceState({
            chatId,
            conversationRootIds: [1],
            quota: { maxFileBytes: 4096, maxConversationBytes: 16_384, maxFiles: 10, maxGlobalBytes: 1_000_000 },
        });
        const previewLimits = { allowHtml: true, maxHtmlBytes: 65_536, maxGzipBytes: 24_576 };
        const toolWithPreview = createWorkspaceTool({
            state: ws,
            widgetLimits: { maxHtmlBytes: 65_536, maxGzipBytes: 24_576 },
            workspacePreview: true,
            previewLimits,
            previewDependencies: {
                renderPng: async () => ({ png: PNG_1X1, width: 600, height: 400 }),
            },
        });
        const toolWithoutPreview = createWorkspaceTool({
            state: ws,
            workspacePreview: false,
        });

        expect(toolWithPreview.definition.name === WORKSPACE_TOOL_NAME, 'tool name is workspace');
        const propsWith = propertiesOf(toolWithPreview.definition.inputSchema);
        const actionPropWith = isRecord(propsWith.action) ? propsWith.action : {};
        expect(stringArrayOf(actionPropWith.enum).includes('preview'), 'preview in action.enum when enabled');
        expect('theme' in propsWith, 'theme present when preview enabled');

        const propsWithout = propertiesOf(toolWithoutPreview.definition.inputSchema);
        const actionPropWithout = isRecord(propsWithout.action) ? propsWithout.action : {};
        expect(!stringArrayOf(actionPropWithout.enum).includes('preview'), 'preview removed when workspacePreview=false');
        expect(!('theme' in propsWithout), 'theme omitted when workspacePreview=false');

        const rejectedPreview = await toolWithoutPreview.execute({ action: 'preview', path: 'a.html' }, signal);
        expect(rejectedPreview.isError === true && rejectedPreview.content.includes('预览'), 'runtime preview rejected when disabled');

        const tools = createTurnTools([toolWithPreview]);
        expect(tools.statusOf('workspace', '{"action":"list"}').text === '📂 正在列工作区…', 'status list');
        expect(tools.statusOf('workspace', '{"action":"read"}').text === '📖 正在读工作区文件…', 'status read');
        expect(tools.statusOf('workspace', '{"action":"write"}').text === '📝 正在写工作区文件…', 'status write');
        expect(tools.statusOf('workspace', '{"action":"edit"}').text === '✏️ 正在修改工作区文件…', 'status edit');
        expect(tools.statusOf('workspace', '{"action":"copy"}').text === '📋 正在复制工作区文件…', 'status copy');
        expect(tools.statusOf('workspace', '{"action":"delete"}').text === '🗑️ 正在删除工作区文件…', 'status delete');
        expect(tools.statusOf('workspace', '{"action":"find"}').text === '🔍 正在搜索工作区…', 'status find');
        expect(tools.statusOf('workspace', '{"action":"preview"}').text === '🖼️ 正在渲染工作区预览…', 'status preview');
        expect(tools.statusOf('workspace', '{}').text === '⚙️ 正在操作工作区…', 'status default');

        const wrote = await toolWithPreview.execute({ action: 'write', path: 'card.html', content: '<div>hi</div>' }, signal);
        expect(!wrote.isError && Boolean(wrote.trace?.argument?.startsWith('write · ')), 'write succeeds with action trace prefix');
        const listed = await toolWithPreview.execute({ action: 'list' }, signal);
        expect(!listed.isError && listed.content.includes('card.html') && Boolean(listed.trace?.argument?.startsWith('list')), 'list succeeds');
        const read = await toolWithPreview.execute({ action: 'read', path: 'card.html' }, signal);
        expect(!read.isError && read.content.includes('1| <div>hi</div>') && Boolean(read.trace?.argument?.startsWith('read · ')), 'read succeeds');
        const edited = await toolWithPreview.execute({ action: 'edit', path: 'card.html', old_string: 'hi', new_string: 'hello' }, signal);
        expect(!edited.isError && Boolean(edited.trace?.argument?.startsWith('edit · ')), 'edit succeeds');
        const found = await toolWithPreview.execute({ action: 'find', query: 'hello' }, signal);
        expect(!found.isError && found.content.includes('card.html:1|') && Boolean(found.trace?.argument?.startsWith('find · ')), 'find succeeds');
        const copied = await toolWithPreview.execute({ action: 'copy', path: 'card.html', new_path: 'card-v1.html' }, signal);
        expect(!copied.isError && Boolean(copied.trace?.argument?.startsWith('copy · ')), 'copy succeeds');
        const previewed = await toolWithPreview.execute({ action: 'preview', path: 'card.html' }, signal);
        expect(!previewed.isError && (previewed.modelImages?.length ?? 0) === 1 && Boolean(previewed.trace?.argument?.startsWith('preview · ')), 'preview renders png');
        const deleted = await toolWithPreview.execute({ action: 'delete', path: 'card-v1.html' }, signal);
        expect(!deleted.isError && Boolean(deleted.trace?.argument?.startsWith('delete · ')), 'delete succeeds');
    })
);

results.push(
    await runCase('harness_issue 2-in-1 list/create, statusText, and trace prefix', async () => {
        const state = createHarnessIssueState();
        const tool = createHarnessIssueTool({ state, chatId: -100555666777 });
        const tools = createTurnTools([tool]);

        expect(tool.definition.name === HARNESS_ISSUE_TOOL_NAME, 'tool name is harness_issue');
        expect(tools.statusOf('harness_issue', '{"action":"list"}').text === '🔍 正在查看 harness issue…', 'list status');
        expect(tools.statusOf('harness_issue', '{"action":"create"}').text === '📝 正在记录 harness issue…', 'create status');

        const created = await tool.execute(
            { action: 'create', title: 'test bug', body: 'details', kind: 'bug', tool_name: 'workspace' },
            signal
        );
        expect(!created.isError && Boolean(created.trace?.argument?.startsWith('create · ')), 'create succeeds with prefix');

        const listed = await tool.execute({ action: 'list', status: 'open', query: 'test bug' }, signal);
        expect(!listed.isError && listed.content.includes('test bug') && Boolean(listed.trace?.argument?.startsWith('list · ')), 'list finds created issue');

        const bad = await tool.execute({ action: 'unknown' }, signal);
        expect(bad.isError === true, 'invalid action rejected');

        for (let i = 1; i < MAX_HARNESS_ISSUES_PER_REPLY; i += 1) {
            await tool.execute({ action: 'create', title: `extra ${i}`, body: 'b', kind: 'improvement' }, signal);
        }
        const overLimit = await tool.execute({ action: 'create', title: 'overflow', body: 'b', kind: 'bug' }, signal);
        expect(overLimit.isError === true, 'per-reply create limit enforced');
    })
);

results.push(
    await runCase('history 2-in-1 search/read, mutual exclusion, statusText, and clickable hN links', async () => {
        const ctx = makeContext();
        const state = createHistoryState();
        const tool = createHistoryTool({
            state,
            context: ctx,
            service: makeFakeHistoryService(),
            channelId: 123,
            ownerUserId: 1,
            botUserId: 99,
        });
        const tools = createTurnTools([tool]);

        expect(tool.definition.name === HISTORY_TOOL_NAME, 'tool name is history');
        expect(tools.statusOf('history', '{"action":"search"}').text === '🔍 正在翻聊天记录…', 'search status');
        expect(tools.statusOf('history', '{"action":"read"}').text === '📖 正在读聊天记录…', 'read status');

        const mixedSearch = await tool.execute({ action: 'search', query: 'abc', ids: ['h1'] }, signal);
        expect(mixedSearch.isError === true && mixedSearch.content.includes('混传'), 'search + ids rejected');

        const mixedRead = await tool.execute({ action: 'read', ids: ['h1'], query: 'abc' }, signal);
        expect(mixedRead.isError === true && mixedRead.content.includes('混传'), 'read + query rejected');

        const searched = await tool.execute({ action: 'search', query: '记录', folded: false, ids: [] }, signal);
        expect(!searched.isError && searched.content.includes('h1') && searched.content.includes('h3'), 'search succeeds with empty fillers ignored');

        const readIds = await tool.execute({ action: 'read', ids: ['h1', 'h2', 'h3'] }, signal);
        expect(!readIds.isError, 'read ids succeeds');
        const recordIds = buildToolCallRecord(
            { id: 'c1', name: 'history', argumentsJson: '{}' },
            readIds,
            10
        );
        expect(
            (recordIds.links?.length ?? 0) === 3 && Boolean(recordIds.argument?.includes('h1')),
            'read ids preserves all 3 clickable hN links within 56 chars'
        );

        const readAround = await tool.execute({ action: 'read', around: 'h1', minutes: 10 }, signal);
        expect(!readAround.isError, 'read around succeeds');
        const recordAround = buildToolCallRecord(
            { id: 'c2', name: 'history', argumentsJson: '{}' },
            readAround,
            10
        );
        expect(
            (recordAround.links?.length ?? 0) === 1 && Boolean(recordAround.argument?.startsWith('around h1')),
            'read around preserves clickable h1 link'
        );

        const dmCtx = makeContext(1);
        const dmTool = createHistoryTool({
            state: createHistoryState(),
            context: dmCtx,
            service: makeFakeHistoryService(),
            channelId: null,
            ownerUserId: 2,
            botUserId: 99,
        });
        const dmSearch = await dmTool.execute({ action: 'search', query: '记录' }, signal);
        expect(!dmSearch.isError && dmSearch.content.includes('全部归档群'), 'DM channelId=null defaults to cross-group scope=all');
    })
);

results.push(
    await runCase('find_image 2-in-1 dynamic schema pruning, mode fallback, statusText, and trace', async () => {
        const ctx = makeContext();
        const media = createReplyMediaState();
        const webDeps = {
            search: makeWebSearch(),
            fetchThumbnail: makeThumbFetch(),
            baseUrl: 'http://127.0.0.1:9',
            engines: 'bing',
            safesearch: 0 as const,
            canSeeImages: true,
        };
        const reverseDeps = {
            search: async () =>
                ({
                    ok: true,
                    cached: false,
                    result: {
                        engines: [{ engine: 'yandex', status: 'ok', cached: false, elapsedMs: 10 }],
                        sites: [{ engine: 'yandex', match: 'exact', title: 'Pixiv', url: 'https://pixiv.net/1', domain: 'pixiv.net', description: 'art' }],
                        sizes: [{ width: 1200, height: 900, url: 'https://example.com/big.png' }],
                        similar: [],
                        tags: ['cat'],
                    },
                }) satisfies ReverseSearchOutcome,
            loadMessageImages: async () => [{ data: PNG_1X1.toString('base64'), mimeType: 'image/png' }],
            loadAnimationFrame: async () => null,
            fetchImage: makeThumbFetch(),
        };

        const both = createFindImageTool({
            state: media,
            webEnabled: true,
            reverseEnabled: true,
            webDependencies: webDeps,
            context: ctx,
            reverseDependencies: reverseDeps,
        });
        const webOnly = createFindImageTool({
            state: createReplyMediaState(),
            webEnabled: true,
            reverseEnabled: false,
            webDependencies: webDeps,
        });
        const reverseOnly = createFindImageTool({
            state: createReplyMediaState(),
            webEnabled: false,
            reverseEnabled: true,
            context: ctx,
            reverseDependencies: reverseDeps,
        });

        expect(both.definition.name === FIND_IMAGE_TOOL_NAME, 'tool name is find_image');
        expect(stringArrayOf(both.definition.inputSchema.required).includes('mode'), 'both enabled requires mode');
        expect(!stringArrayOf(webOnly.definition.inputSchema.required).includes('mode'), 'web-only omits required mode');
        expect(!('message' in propertiesOf(webOnly.definition.inputSchema)), 'web-only prunes reverse fields');
        expect(!('query' in propertiesOf(reverseOnly.definition.inputSchema)), 'reverse-only prunes web fields');
        expect('search_id' in propertiesOf(reverseOnly.definition.inputSchema), 'reverse-only keeps search_id');

        const toolsBoth = createTurnTools([both]);
        expect(toolsBoth.statusOf('find_image', '{"mode":"web"}').text === '🔍 正在找图…', 'web status');
        expect(toolsBoth.statusOf('find_image', '{"mode":"reverse"}').text === '🔎 正在以图搜图…', 'reverse status');
        expect(createTurnTools([reverseOnly]).statusOf('find_image', '{}').text === '🔎 正在以图搜图…', 'reverse-only omitted mode status');

        const webRes = await webOnly.execute({ query: '猫猫' }, signal);
        expect(
            !webRes.isError &&
                webRes.content.includes("find_image(mode='web'") &&
                Boolean(webRes.trace?.argument?.startsWith('web · ')) &&
                Boolean(webRes.record?.searchQueries?.[0]?.startsWith('find_image: ')),
            'web-only auto-defaults mode, sets trace prefix and searchQueries'
        );
        const blockedReverse = await webOnly.execute({ mode: 'reverse', message: 1 }, signal);
        expect(blockedReverse.isError === true, 'web-only rejects reverse mode');

        const revRes = await reverseOnly.execute({ message: 1 }, signal);
        expect(!revRes.isError && Boolean(revRes.trace?.argument?.startsWith('reverse · ')), 'reverse-only auto-defaults mode and sets trace prefix');
        const blockedWeb = await reverseOnly.execute({ mode: 'web', query: '猫' }, signal);
        expect(blockedWeb.isError === true, 'reverse-only rejects web mode');
    })
);

results.push(
    await runCase('react_to_message removes nested emoji enum and still validates at runtime', async () => {
        const ctx = makeContext();
        const tool = createReactToMessageTool(ctx);
        const props = propertiesOf(tool.definition.inputSchema);
        const reactionsProp = isRecord(props.reactions) ? props.reactions : {};
        const itemsProp = isRecord(reactionsProp.items) ? reactionsProp.items : {};
        const itemProps = isRecord(itemsProp.properties) ? itemsProp.properties : {};
        const nestedEmoji = isRecord(itemProps.emoji) ? itemProps.emoji : {};
        const topEmoji = isRecord(props.emoji) ? props.emoji : {};

        expect(!('enum' in nestedEmoji), 'reactions[].emoji no longer repeats enum');
        expect(stringArrayOf(topEmoji.enum).length === REACTION_EMOJIS.length, 'top-level emoji keeps REACTION_EMOJIS');

        const badEmoji = await tool.execute({ reactions: [{ message: 1, emoji: '🚀' }] }, signal);
        expect(badEmoji.isError === true && badEmoji.content.includes('标准 reaction'), 'runtime still rejects invalid nested emoji');
    })
);

results.push(
    await runCase('all 16 tools pass 6-platform schema checks and stay within 14276 chars / 5073 tokB', async () => {
        const ctx = makeContext();
        const media = createReplyMediaState();
        const ws = createWorkspaceState({
            chatId: ctx.chatId,
            conversationRootIds: [1],
            quota: { maxFileBytes: 4096, maxConversationBytes: 16_384, maxFiles: 10, maxGlobalBytes: 1_000_000 },
        });
        const hs = createHistoryState();
        const his = createHarnessIssueState();
        const limits = { allowHtml: true, maxHtmlBytes: 65_536, maxGzipBytes: 24_576 };

        const definitions: ToolDefinition[] = [
            createSendSmsTool(ctx).definition,
            createGenerateImageTool(ctx, media, { sticker: { setName: 'p', api: ctx.api } }).definition,
            createFindImageTool({
                state: media,
                webEnabled: true,
                reverseEnabled: true,
                webDependencies: {
                    search: makeWebSearch(),
                    fetchThumbnail: makeThumbFetch(),
                    baseUrl: '',
                    engines: '',
                    safesearch: 0,
                    canSeeImages: true,
                },
                context: ctx,
            }).definition,
            createFetchImageTool({
                state: media,
                dependencies: PRODUCTION_FETCH_DEPENDENCIES,
                sticker: { setName: 'p', api: ctx.api },
                history: {
                    state: hs,
                    service: makeFakeHistoryService(),
                    channelId: 123,
                    ownerUserId: 1,
                    requesterUserId: 2,
                },
                avatar: {
                    chatId: ctx.chatId,
                    botUserId: 9,
                    contextIndex: ctx.contextIndex,
                    dependencies: { api: ctx.api, lookupUsername: async () => null },
                },
            }).definition,
            createCropImageTool({ state: media, context: ctx }).definition,
            createExtractFramesTool({ state: media, context: ctx }).definition,
            createSendImageTool({ state: media, context: ctx }).definition,
            createSendStickerTool({ state: media, context: { api: ctx.api, signal }, setName: 'p', canPreview: true }).definition,
            createSendFileTool({ state: media, workspace: ws }).definition,
            createSendWidgetTool({ state: media, limits, workspace: ws }).definition,
            createWorkspaceTool({
                state: ws,
                widgetLimits: limits,
                workspacePreview: true,
                previewLimits: limits,
            }).definition,
            createLeaveHandoffTool({ state: ws, finalRoundTool: true }).definition,
            createHistoryTool({
                state: hs,
                context: ctx,
                service: makeFakeHistoryService(),
                channelId: 123,
                ownerUserId: 1,
                botUserId: 9,
            }).definition,
            createHarnessIssueTool({ state: his, chatId: ctx.chatId }).definition,
            createReactToMessageTool(ctx).definition,
            {
                name: 'load_skill',
                description: '批量加载指定技能的完整参考规范（仅本次回复有效）。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        names: {
                            type: 'array',
                            items: { type: 'string' },
                            minItems: 1,
                            maxItems: 4,
                            description: '要加载的技能名列表',
                        },
                    },
                    required: ['names'],
                },
            },
        ];

        for (const def of definitions) {
            expect(def.inputSchema.type === 'object', `${def.name} top-level type is object`);
            expect(!('oneOf' in def.inputSchema) && !('anyOf' in def.inputSchema) && !('allOf' in def.inputSchema), `${def.name} has no top-level oneOf/anyOf/allOf`);
        }

        // Verify all 6 platform wire converters accept the 16 definitions
        expect(toChatCompletionTools(definitions).length === 16, 'Chat Completions (DeepSeek/MiMo) accepts 16 tools');
        expect(toResponsesFunctionTools(definitions).length === 16, 'Responses API (OpenAI/Grok) accepts 16 tools');
        expect(toAnthropicTools(definitions).length === 16, 'Anthropic accepts 16 tools');
        expect(toGeminiFunctionDeclarations(definitions).length === 16, 'Gemini accepts 16 tools');

        let totalChars = 0;
        let totalTokB = 0;
        for (const def of definitions) {
            const schemaJson = JSON.stringify(def.inputSchema);
            const c = countChars(def.name) + countChars(def.description) + countChars(schemaJson);
            const t = countTokB(`${def.name}${def.description}${schemaJson}`);
            totalChars += c;
            totalTokB += t;
            console.log(`  [budget] ${def.name}: ${c} chars / ${t} tokB`);
        }
        console.log(`  [budget] TOTAL(16): ${totalChars} chars / ${totalTokB} tokB`);
        expect(totalChars <= 14_276, `total net chars ${totalChars} <= 14276`);
        expect(totalTokB <= 5_073, `total net tokB ${totalTokB} <= 5073`);
    })
);

reportResults(results);
