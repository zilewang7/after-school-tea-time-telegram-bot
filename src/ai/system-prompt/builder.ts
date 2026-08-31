/**
 * Assemble the per-request system prompt from three layers:
 *   1. preference (env/mounted file, operator-editable persona)
 *   2. dynamic environment (current time, current model id)
 *   3. built-in static sections (message format protocol, capabilities, notes)
 */
import { getModelCapabilities } from '../platform-factory.js';
import { getPreferencePrompt } from './preference.js';
import { buildFormatSection, CAPABILITIES_SECTION, NOTES_SECTION } from './sections.js';
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

const buildEnvironmentSection = (model: string): string => `# 当前环境

- 当前时间：${formatCurrentTime()}
- 当前模型：${model}`;

/** One roster entry, shared by the human and bot lists */
const rosterLine = (user: ContextUser): string => {
    const name = user.lastName ? `${user.firstName} ${user.lastName}` : user.firstName;
    const id = user.userId === undefined ? 'id 未知' : `id ${user.userId}`;
    const handle = user.username ? `@${user.username}` : '无 username';
    const tag = user.mentionedOnly ? '（仅被提及，未在上下文中发言）' : '';
    return `- ${name}：${id}，${handle}${tag}`;
};

/** Roster of the users this context involves, so mentions come out right.
 *  Bots are listed apart so the model never tries to @ one. */
const buildRosterSection = (users: ContextUser[]): string => {
    const humans = users.filter((user) => user.isBot !== true);
    const bots = users.filter((user) => user.isBot === true);

    const blocks: string[] = ['# 上下文中的用户'];
    if (humans.length) {
        blocks.push(humans.map(rosterLine).join('\n'));
    }
    if (bots.length) {
        blocks.push(`以下是 bot 账号（不是人，@ 它们没有任何作用，不要提及）：
${bots.map(rosterLine).join('\n')}`);
    }
    blocks.push(`需要提及（@）某用户时，优先写 \`[名字](tg://user?id=数字)\`（名字用对方的 first name），
会渲染成可点击的提及；只有拿不到 id 时才退而写 @username。你本来就在回复最后一条消息，
无需再 @ 它的作者；也不要 @ 与话题无关的人。`);
    return blocks.join('\n\n');
};

export interface SystemPromptExtras {
    /** Users involved in the current context (authors + mentioned) */
    contextUsers?: ContextUser[];
}

export const buildSystemPrompt = (model: string, extras?: SystemPromptExtras): string => {
    const capabilities = getModelCapabilities(model);
    const contextUsers = extras?.contextUsers ?? [];

    return [
        getPreferencePrompt(),
        buildEnvironmentSection(model),
        contextUsers.length > 0 ? buildRosterSection(contextUsers) : '',
        buildFormatSection({ includeOcrNote: !capabilities.supportsImageInput }),
        CAPABILITIES_SECTION,
        NOTES_SECTION,
    ]
        .filter((section) => section.length > 0)
        .join('\n\n');
};
