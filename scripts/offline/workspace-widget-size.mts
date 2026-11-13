/**
 * Offline case for the workspace ↔ widget wiring: a turn that offers
 * `send_widget` must hand the widget budget to `workspace_write` /
 * `workspace_edit` / `workspace_list`, so an HTML draft reports its zlib9 size
 * without a preview or a rejected send.
 *
 * The unit wording lives in workspace.mts; this file only checks that
 * `createReplyTools` actually connects the two features.
 *
 * Run: npx tsx scripts/offline/workspace-widget-size.mts
 */
import type { Chat } from 'grammy/types';
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import { createUnusedApi } from './fake-telegram.mts';
import type { ToolCall, TurnTools } from '../../src/ai/tools/tool-types.js';

/** A private chat: send_widget is offered there without the group fallback */
const CHAT_ID = 5151;

// Before any project import: the tool config snapshots the env on first read
process.env.WORKSPACE_ENABLE = '1';
process.env.WIDGET_ENABLE = '1';
process.env.TOOL_CHAT_IDS = String(CHAT_ID);
process.env.OWNER_USER_ID = '4242';
process.env.BOT_USER_ID = '7777';

await setupOfflineDb();

const { buildReplyToolContext } = await import('../../src/reply/tools/reply-tool-context.js');
const { createReplyTools } = await import('../../src/reply/tools/create-reply-tools.js');
const { measureWidgetHtml } = await import('../../src/ai/widget/widget-size.js');

const chat: Chat.PrivateChat = { id: CHAT_ID, type: 'private', first_name: '测试' };
const signal = new AbortController().signal;

const contextOf = () =>
    buildReplyToolContext({
        chat,
        triggerMessage: { messageId: 1, userId: 42, userName: '张三', text: '画个卡片' },
        contextIndex: new Map(),
        conversationRootIds: [1],
        signal,
        api: createUnusedApi(),
    });

const callTool = (
    tools: TurnTools,
    name: string,
    args: Readonly<Record<string, unknown>>
): Promise<{ content: string; isError: boolean }> => {
    const call: ToolCall = { id: `call-${name}`, name, argumentsJson: JSON.stringify(args) };
    return tools.execute(call, signal);
};

const results: CaseResult[] = [];

results.push(
    await runCase('a widget turn hands the widget budget to the workspace tools', async () => {
        const turn = createReplyTools('gemini-4-argon', contextOf(), null, 'full');
        expect(turn.availability.workspace, 'the workspace tools are offered');
        expect(turn.availability.widget, 'send_widget is offered');

        const html = '<div class="card"><b>你好</b></div>';
        const size = measureWidgetHtml(html);
        const written = await callTool(turn.tools, 'workspace_write', {
            path: 'widgets/card.html',
            content: html,
        });
        expect(!written.isError, `the write succeeds (${written.content})`);
        expect(
            written.content.includes(`zlib9 ${size.zlibBytes} B / 4096 B`),
            `the write reports the compressed size (got ${written.content})`
        );

        const edited = await callTool(turn.tools, 'workspace_edit', {
            path: 'widgets/card.html',
            old_string: '你好',
            new_string: '再见',
        });
        expect(!edited.isError, `the edit succeeds (${edited.content})`);
        expect(edited.content.includes('zlib9 '), 'the edit reports the compressed size too');

        const listed = await callTool(turn.tools, 'workspace_list', {});
        expect(listed.content.includes('HTML 草稿按 widget 计'), 'the list states the widget limits');
        expect(listed.content.includes('zlib9 '), 'the list shows the compressed size');
    })
);

reportResults(results);
