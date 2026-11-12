import { match, P } from 'ts-pattern';
import type { ChatAccess, ChatSummary, ChatType, PanelUser } from './api';
import { issueStatusLabel } from './issues/issue-labels';
import { parseToolOverridesJson, TOOL_GROUP_ORDER, toolGroupLabelOf } from './tool-groups';

const CHAT_TYPE_LABELS: Record<ChatType, string> = {
    private: '私聊',
    group: '群',
    supergroup: '超级群',
    channel: '频道',
};

const ACCESS_LABELS: Record<ChatAccess, string> = {
    member: '成员',
    observer: '观察者',
};

const AUDIT_KEY_LABELS: Partial<Record<string, string>> = {
    model: '模型',
    promptAddendum: '附加提示词',
    paused: '暂停',
    settingsLocked: '锁定设置',
    defaultModel: '全局默认模型',
    geminiPriority: 'Priority PayGo',
    defaultGeminiPriority: '全局 Priority PayGo',
    toolOverrides: '工具开关',
    exclude: '排除消息',
    include: '恢复消息',
    link: '拼接对话',
    create: '新建 issue',
    status: 'issue 状态',
    note: '处理备注',
};

// Boolean settings, audited as 'true' / 'false'
const ON_OFF_AUDIT_KEYS = ['paused', 'settingsLocked', 'geminiPriority', 'defaultGeminiPriority'] as const;

export const chatTypeLabel = (type: ChatType): string => CHAT_TYPE_LABELS[type];

export const accessLabel = (access: ChatAccess): string => ACCESS_LABELS[access];

/** What a chat's name is built from; a ChatSummary or the chat detail's header fits */
export interface ChatNameSource {
    chatId: number;
    // null when the bot does not know the chat (e.g. an issue's chat missing from the registry)
    type: ChatType | null;
    title: string | null;
    username: string | null;
}

/** Group title or the user's name; a chat not named yet falls back to its type and id */
export const chatNameOf = (chat: ChatNameSource): string =>
    chat.title ?? `${chat.type === null ? '聊天' : chatTypeLabel(chat.type)} ${chat.chatId}`;

/** "@username" when the chat has a public username */
export const chatUsernameOf = (chat: ChatNameSource): string | null =>
    chat.username === null || chat.username === '' ? null : `@${chat.username}`;

/** Name followed by the @username, for plain-text places */
export const chatLabelOf = (chat: ChatNameSource): string => {
    const username = chatUsernameOf(chat);
    return username === null ? chatNameOf(chat) : `${chatNameOf(chat)} ${username}`;
};

export const auditKeyLabel = (key: string): string => AUDIT_KEY_LABELS[key] ?? key;

export const userDisplayName = (user: PanelUser): string =>
    user.lastName === null ? user.firstName : `${user.firstName} ${user.lastName}`;

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** "11-06 14:02" in the device time zone; the year is added when it is not the current one */
export const formatDateTime = (iso: string): string => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const dayAndTime = `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    return date.getFullYear() === new Date().getFullYear() ? dayAndTime : `${date.getFullYear()}-${dayAndTime}`;
};

/** "11-06" in the device time zone; the year is added when it is not the current one */
export const formatDate = (iso: string): string => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const day = `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    return date.getFullYear() === new Date().getFullYear() ? day : `${date.getFullYear()}-${day}`;
};

/** "历史检索开，贴纸关" from the audit's canonical JSON; null = following the env */
const formatToolOverridesValue = (value: string | null): string => {
    const overrides = parseToolOverridesJson(value);
    if (overrides === null) return '跟随环境配置';
    const parts = TOOL_GROUP_ORDER.flatMap((key) => {
        const state = overrides[key];
        return state === undefined ? [] : [`${toolGroupLabelOf(key)}${state ? '开' : '关'}`];
    });
    return parts.length === 0 ? '跟随环境配置' : parts.join('，');
};

/** Human-readable audit value; null means "unset", whose meaning depends on the key */
export const formatAuditValue = (key: string, value: string | null): string =>
    match({ key, value })
        .with({ key: 'model', value: P.nullish }, () => '跟随全局默认')
        .with({ key: 'defaultModel', value: P.nullish }, () => '环境变量默认')
        .with({ key: 'geminiPriority', value: P.nullish }, () => '跟随全局')
        // No global row means off
        .with({ key: 'defaultGeminiPriority', value: P.nullish }, () => '关（未设置）')
        // Tool switches: null (and unreadable JSON) means every group follows the env
        .with({ key: 'toolOverrides' }, ({ value: overridesText }) => formatToolOverridesValue(overridesText))
        .with({ value: P.nullish }, () => '（空）')
        .with({ key: P.union(...ON_OFF_AUDIT_KEYS), value: 'true' }, () => '开')
        .with({ key: P.union(...ON_OFF_AUDIT_KEYS), value: 'false' }, () => '关')
        // An issue's status change (scope issue:<id>)
        .with({ key: 'status', value: P.string }, ({ value: status }) => issueStatusLabel(status))
        .with({ value: P.string }, ({ value: text }) => text)
        .exhaustive();

/** Scope of a global audit entry: global, chat:<id> or issue:<id> */
export const auditScopeLabel = (scope: string, chats: readonly ChatSummary[]): string =>
    match(scope)
        .with('global', () => '全局')
        .with(P.string.startsWith('chat:'), (chatScope) => {
            const chatId = Number(chatScope.slice('chat:'.length));
            const chat = chats.find((candidate) => candidate.chatId === chatId);
            return chat === undefined ? chatScope : chatLabelOf(chat);
        })
        .with(P.string.startsWith('issue:'), (issueScope) => `issue #${issueScope.slice('issue:'.length)}`)
        .otherwise((unknownScope) => unknownScope);
