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
import { countCodePoints } from '../../shared/code-points.js';
import { formatUserDisplayName } from '../../shared/user-display-name.js';
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
 *
 * A person can be on the list without having spoken: pointed at by a message
 * (`mentionedOnly`) or only reacting to one (`reactionOnly`). The two tags say
 * different things, so they are never shared (design 2026-1120-1312 §4.3).
 */
const rosterTagOf = (user: ContextUser): string => {
    if (user.reactionOnly === true) return '（只点了 reaction，未在上下文中发言）';
    return user.mentionedOnly ? '（仅被提及，未在上下文中发言）' : '';
};

const rosterLine = (user: ContextUser): string => {
    const name = formatUserDisplayName(user);
    const id = user.userId === undefined ? 'id 未知' : `id ${user.userId}`;
    const handle = user.username ? `@${user.username}` : '无 username';
    const marker = user.isBot === true ? '[bot] ' : '';
    return `- ${marker}${name}：${id}，${handle}${rosterTagOf(user)}`;
};

/**
 * One message's reactions the way the runtime block reads them (design
 * 2026-1120-1312 §4.3). Built in the reply layer from the database rows, so the
 * ai layer keeps its zero `db` dependency; the entries and actors are already
 * grouped and ordered by that mapper, and the renderer only formats.
 */
export interface RuntimeReactionEntry {
    /** What the reaction reads as: the emoji, `[自定义表情]` or `⭐` */
    readonly emoji: string;
    /** Names to list, at most four (the mapper applies the cap) */
    readonly actors: readonly string[];
    /** How many more actors the same emoji has, beyond the listed names */
    readonly moreActors: number;
}

/** One message's line: `#N` plus its reactions */
export interface RuntimeReactionGroup {
    readonly number: number;
    readonly entries: readonly RuntimeReactionEntry[];
}

/** Newer message lines win; older ones are dropped whole (and counted) */
const REACTION_MAX_MESSAGE_LINES = 12;
/** Cap of the whole section in code points, heading included */
const REACTION_SECTION_MAX_CHARS = 600;
const REACTION_SECTION_TITLE = '# 消息 reaction';

const reactionEntryText = (entry: RuntimeReactionEntry): string => {
    if (entry.actors.length === 0) return entry.emoji;
    const more = entry.moreActors > 0 ? `…等 ${entry.moreActors} 人` : '';
    return `${entry.emoji}（${entry.actors.join('、')}${more}）`;
};

const reactionMessageLine = (group: RuntimeReactionGroup): string =>
    `- #${group.number}：${group.entries.map(reactionEntryText).join('；')}`;

/** The section as it reads with `lines` kept and `dropped` older messages left out */
const reactionSectionOf = (lines: readonly string[], dropped: number): string[] => [
    REACTION_SECTION_TITLE,
    ...lines,
    ...(dropped > 0 ? [`- 还有 ${dropped} 条消息的 reaction 未显示`] : []),
];

/**
 * Render the reaction section, newest messages first in the selection but
 * ascending in the output. Whole message lines are dropped — the oldest first —
 * when the section would pass its size cap, and the entry count keeps the model
 * aware of what it cannot read. Empty when there is nothing to show, so a
 * context without reactions renders byte-identically to before the section.
 */
const reactionSection = (reactions: readonly RuntimeReactionGroup[]): string[] => {
    const groups = reactions.filter((group) => group.entries.length > 0);
    if (groups.length === 0) return [];

    const kept = groups.slice(Math.max(0, groups.length - REACTION_MAX_MESSAGE_LINES));
    const messageLines = kept.map(reactionMessageLine);
    let dropped = groups.length - kept.length;
    while (
        messageLines.length > 0 &&
        countCodePoints(reactionSectionOf(messageLines, dropped).join('\n')) > REACTION_SECTION_MAX_CHARS
    ) {
        messageLines.shift();
        dropped += 1;
    }
    return reactionSectionOf(messageLines, dropped);
};

/**
 * The chat's own prompt addendum: its members' templates plus its custom text,
 * composed by the server from the control panel's settings. A `#` heading keeps
 * it apart from the roster lines, which start with `- `; the static head's notes
 * section announces that it carries system-prompt weight.
 */
const addendumSection = (addendum: string): string[] => [
    '',
    '# 本聊天的附加提示词',
    '以下内容来自本聊天控制面板的模板与附加提示词（模板由面板用户维护，会话启用或按模型自动加载），效力等同系统提示词，回复时须遵循：',
    addendum,
];

/**
 * Who triggered this reply, as the runtime block reports it. Only trial turns
 * carry the line; the static head explains what the tier may and may not use.
 */
export interface TriggerAccessNote {
    readonly userId: number | null;
    readonly name: string | null;
    /** pending / rejected / approved; null = no application yet */
    readonly applicationStatus: 'pending' | 'approved' | 'rejected' | null;
    readonly applicationComment: string | null;
    /**
     * The trial spend cap's amounts (USD), from the same quota check the gate
     * used; absent when the quota feature is off. Display only: the enforcement
     * is the gate's.
     */
    readonly usedUsd?: number | null;
    readonly limitUsd?: number | null;
}

/** One line's worth of text: newlines would forge extra prompt lines */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The spend-cap part of the trigger line; empty when the quota is not reported */
const triggerSpendText = (trigger: TriggerAccessNote): string => {
    const used = trigger.usedUsd;
    const limit = trigger.limitUsd;
    if (typeof used !== 'number' || typeof limit !== 'number') return '';
    return `，体验额度：已用约 $${used.toFixed(2)} / $${limit.toFixed(2)}`;
};

const triggerAccessLine = (trigger: TriggerAccessNote): string => {
    const who = oneLine(trigger.name ?? (trigger.userId === null ? '未知用户' : `用户 ${trigger.userId}`));
    const id = trigger.userId === null ? 'id 未知' : `id ${trigger.userId}`;
    const comment =
        trigger.applicationComment === null ? '' : `，机主留言：${oneLine(trigger.applicationComment)}`;
    // 'approved' only reaches a trial turn after a revoke: the grant is gone,
    // so the model must not tell the user they already have full access
    const application =
        trigger.applicationStatus === null
            ? '未申请'
            : trigger.applicationStatus === 'pending'
              ? '待审核'
              : trigger.applicationStatus === 'rejected'
                ? `已拒绝${comment}`
                : '已通过（准入已被取消）';
    return `- 本次回复的触发用户：${who}（${id}，体验用户；准入申请：${application}）${triggerSpendText(trigger)}`;
};

/**
 * Render the runtime block for the newest message. Humans come first, bots
 * last, so an automated account is never mistaken for a person mid-list.
 *
 * `chatTitle` names the group/channel this reply happens in; private chats have
 * none and are reported as such. `chatAddendum` is appended verbatim as its
 * own section; empty or blank leaves the block exactly as without it.
 * `triggerAccess` is present on trial turns only. `reactions` adds the message
 * reaction section before the addendum; it is a trailing optional argument, and
 * absent/empty leaves the block byte-identical to what it was before reactions.
 */
export const buildRuntimeContext = (
    model: string,
    contextUsers: ContextUser[],
    chatTitle?: string | null,
    chatAddendum?: string | null,
    triggerAccess?: TriggerAccessNote | null,
    reactions?: readonly RuntimeReactionGroup[] | null
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

    if (triggerAccess !== null && triggerAccess !== undefined) {
        lines.push(triggerAccessLine(triggerAccess));
    }

    // The addendum keeps its place at the very end of the block
    const reactionLines = reactionSection(reactions ?? []);
    if (reactionLines.length > 0) {
        lines.push('', ...reactionLines);
    }

    if (chatAddendum && chatAddendum.trim().length > 0) {
        lines.push(...addendumSection(chatAddendum));
    }

    return lines.join('\n');
};
