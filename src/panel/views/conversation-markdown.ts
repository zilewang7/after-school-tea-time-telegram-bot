/**
 * The Markdown form of a conversation export. Every piece of message or model
 * text goes into a fenced block whose fence is longer than any backtick run
 * inside it, so nothing a user wrote is ever rendered as Markdown.
 */
import { match } from 'ts-pattern';
import type { ConversationExport } from './conversation-export.js';
import type { ModelView } from './model-view.js';
import type { ReplyDetailView, ReplyVersionView } from './reply-view.js';
import type { ToolRecordsView } from './tool-records-view.js';
import type { BotNode, MemberUserNode, TreeNode } from './tree-nodes.js';

const longestBacktickRun = (text: string): number => {
    let longest = 0;
    for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
    return longest;
};

const fenced = (text: string): string => {
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
    return `${fence}text\n${text}\n${fence}`;
};

const numberLabel = (number: number | null): string => (number === null ? '—' : `#${number}`);

const edgeLabel = (node: TreeNode): string =>
    match(node.edge)
        .with('reply', () => `回复 ${node.parentId ?? '?'}`)
        .with('link', () => `经拼接 / /chat 自 ${node.parentId ?? '?'} 引入`)
        .with('reply-target', () => `被 ${node.parentId ?? '?'} 回复（树外）`)
        .with(null, () => '根')
        .exhaustive();

const userNodeSection = (node: MemberUserNode): string[] => {
    const author = node.author.username ? `${node.author.name} (@${node.author.username})` : node.author.name;
    const lines = [
        `### ${numberLabel(node.number)} · ${author} · ${node.date}${node.excluded ? ' · 已排除' : ''}`,
        '',
        `- 消息 id：${node.messageId}（${edgeLabel(node)}）`,
    ];
    if (node.annotations.length > 0) lines.push(`- 标注：${node.annotations.join(' ')}`);
    if (node.telegramLink !== null) lines.push(`- 跳转：${node.telegramLink}`);
    if (node.text !== null && node.text !== '') lines.push('', fenced(node.text));
    if (node.quote !== null) lines.push('', '引用：', '', fenced(node.quote));
    if (node.ocrText !== null) lines.push('', '图片文字（OCR）：', '', fenced(node.ocrText));
    if (node.linkPreview !== null) lines.push('', '链接预览：', '', fenced(node.linkPreview));
    return lines;
};

const botNodeSection = (node: BotNode): string[] => [
    `### ${numberLabel(node.number)} · bot · ${node.date}${node.excluded ? ' · 已排除' : ''}`,
    '',
    `- 消息 id：${node.messageId}（${edgeLabel(node)}），全部版本见「回复」`,
    ...(node.reply.text ? ['', fenced(node.reply.text)] : []),
];

const nodeSection = (node: TreeNode): string[] =>
    match(node)
        .with({ kind: 'bot' }, (bot) => botNodeSection(bot))
        .with({ kind: 'user', redacted: false }, (user) => userNodeSection(user))
        // Exports are members only; a placeholder node never reaches here
        .with({ kind: 'user', redacted: true }, (user) => [`### ${numberLabel(user.number)} · 用户消息 · ${user.date}`])
        .exhaustive();

const toolLines = (tools: ToolRecordsView): string[] => {
    const lines: string[] = [];
    if (tools.mode !== null) lines.push(`- 模式：${tools.mode}`);
    for (const usage of tools.toolUsage) {
        lines.push(`- ${usage.name} ×${usage.count}${usage.failed > 0 ? `（${usage.failed} 次失败）` : ''}`);
    }
    for (const call of tools.calls) lines.push(`- 调用：${call}`);
    for (const summary of tools.codeInterpreter) lines.push(`- code interpreter：${summary}`);
    for (const source of tools.sources) lines.push(`- 来源：${source.title ?? source.uri} <${source.uri}>`);
    for (const search of tools.searches) {
        if (search.queries.length > 0) lines.push(`- 搜索：${search.queries.join(' | ')}`);
        if (search.imageQueries.length > 0) lines.push(`- 图片搜索：${search.imageQueries.join(' | ')}`);
        for (const source of search.sources) lines.push(`- 搜索来源：${source.title ?? source.uri} <${source.uri}>`);
    }
    return lines;
};

const versionSection = (version: ReplyVersionView): string[] => {
    const lines = [
        `#### 第 ${version.versionId} 版 · ${version.model ?? '模型未知'} · ${version.createdAt}${version.wasStoppedByUser ? ' · 已被停止' : ''}`,
    ];
    if (version.errorMessage !== null) lines.push('', '错误：', '', fenced(version.errorMessage));
    if (version.text !== '') lines.push('', '正文：', '', fenced(version.text));
    if (version.thinkingText !== null) lines.push('', '思考：', '', fenced(version.thinkingText));
    const tools = toolLines(version.tools);
    if (tools.length > 0) lines.push('', '工具：', '', ...tools);
    for (const attachment of version.attachments) {
        lines.push('', `附件：${attachment.kind} ${attachment.mimeType ?? ''} ${attachment.sizeBytes} 字节`.trim());
    }
    return lines;
};

const replySection = (reply: ReplyDetailView): string[] => [
    `### 回复 ${reply.firstMessageId}（${reply.versionCount} 个版本${reply.currentVersion !== null ? `，当前第 ${reply.currentVersion} 版` : ''}）`,
    '',
    `- 回答的消息：${reply.userMessageId}`,
    ...reply.versions.flatMap((version) => ['', ...versionSection(version)]),
];

const modelViewSection = (modelView: ModelView): string[] => [
    `- 等同于现在点重试，重算于 ${modelView.computedAt}，不是当时请求的快照`,
    `- 模型：${modelView.model}${modelView.asModel ? '（临时换用）' : ''}`,
    `- 回答的消息：${modelView.at}${modelView.excludedReplyId !== null ? `；重试时替换的回复 ${modelView.excludedReplyId} 不在上下文里` : ''}`,
    `- 本轮声明的工具：${modelView.tools.length > 0 ? modelView.tools.join(', ') : '无'}`,
    '',
    '### 静态头',
    '',
    fenced(modelView.systemPrompt),
    ...modelView.turns.flatMap((turn, index) => [
        '',
        `### Turn ${index + 1} · ${turn.role}`,
        '',
        fenced(turn.parts.map((part) => part.text).join('\n\n')),
    ]),
];

export const renderConversationMarkdown = (exported: ConversationExport): string => {
    const title = exported.chat.title ?? `${exported.chat.type} ${exported.chat.chatId}`;
    const lines = [
        `# 会话导出：${title} · 会话 ${exported.rootId}`,
        '',
        `- 导出时间：${exported.exportedAt}`,
        `- 聊天：${title}${exported.chat.username ? ` (@${exported.chat.username})` : ''}，${exported.chat.type} ${exported.chat.chatId}`,
        '',
        '## 树',
        ...exported.tree.nodes.flatMap((node) => ['', ...nodeSection(node)]),
        '',
        '## 回复',
        ...exported.replies.flatMap((reply) => ['', ...replySection(reply)]),
        '',
        '## 模型视角',
        '',
        ...(exported.modelView !== null
            ? modelViewSection(exported.modelView)
            : [`- 无法计算：${exported.modelViewUnavailable ?? '未知原因'}`]),
        '',
    ];
    return lines.join('\n');
};
