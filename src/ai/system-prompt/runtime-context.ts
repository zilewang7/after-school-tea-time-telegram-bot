/**
 * The volatile half of what used to be the system prompt: current time, model
 * id and the user roster.
 *
 * context-builder appends this block to the newest message of a request, so it
 * always sits *after* everything cacheable: the prompt head stays byte-identical
 * between requests and upstream prefix caches can hit (see
 * docs/2026-1010-1905-设计-Gemini上下文缓存与提示词分层.md). Keep everything that
 * changes between requests in here, never in builder.ts.
 */
import type { ContextUser } from '../types.js';

const formatCurrentTime = (): string => {
    const timeZone = process.env.TZ || 'Asia/Shanghai';
    const now = new Date();
    // zh-CN yields "2026/08/31", "13:49" and "周一" respectively
    const date = new Intl.DateTimeFormat('zh-CN', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(now);
    const time = new Intl.DateTimeFormat('zh-CN', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(now);
    const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone, weekday: 'short' }).format(now);
    return `${date} ${time} ${weekday}（${timeZone}）`;
};

/**
 * One roster entry, marked `[bot]` when the account is an automated one — the
 * static head explains the marker, so it stays short here.
 */
const rosterLine = (user: ContextUser): string => {
    const name = user.lastName ? `${user.firstName} ${user.lastName}` : user.firstName;
    const id = user.userId === undefined ? 'id 未知' : `id ${user.userId}`;
    const handle = user.username ? `@${user.username}` : '无 username';
    const marker = user.isBot === true ? '[bot] ' : '';
    const tag = user.mentionedOnly ? '（仅被提及，未在上下文中发言）' : '';
    return `- ${marker}${name}：${id}，${handle}${tag}`;
};

/**
 * The chat's own prompt addendum, set by its members from the control panel.
 * A `#` heading keeps it apart from the roster lines, which start with `- `;
 * the static head's notes section announces that it carries system-prompt
 * weight.
 */
const addendumSection = (addendum: string): string[] => [
    '',
    '# 本聊天的附加提示词',
    '以下由本聊天成员通过控制面板设置，效力等同系统提示词，回复时须遵循：',
    addendum,
];

/**
 * Render the runtime block for the newest message. Humans come first, bots
 * last, so an automated account is never mistaken for a person mid-list.
 *
 * `chatTitle` names the group/channel this reply happens in; private chats have
 * none and are reported as such. `chatAddendum` is appended verbatim as its
 * own section; empty or blank leaves the block exactly as without it.
 */
export const buildRuntimeContext = (
    model: string,
    contextUsers: ContextUser[],
    chatTitle?: string | null,
    chatAddendum?: string | null
): string => {
    const lines = [
        '[system] 运行时信息：',
        `- 当前时间：${formatCurrentTime()}`,
        chatTitle ? `- 当前群聊：${chatTitle}` : '- 当前对话：私聊',
        `- 当前模型：${model}`,
    ];

    if (contextUsers.length > 0) {
        const humans = contextUsers.filter((user) => user.isBot !== true);
        const bots = contextUsers.filter((user) => user.isBot === true);
        lines.push('- 本次回复涉及的用户：', ...humans.map(rosterLine), ...bots.map(rosterLine));
    }

    if (chatAddendum && chatAddendum.trim().length > 0) {
        lines.push(...addendumSection(chatAddendum));
    }

    return lines.join('\n');
};
