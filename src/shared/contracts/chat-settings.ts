/**
 * Canonical per-chat setting keys shared by settings rules, PATCH body parsing,
 * audit formatting, and the Mini App settings form.
 *
 * Pure TypeScript with zero Node/DOM/external dependencies.
 */

/** Fixed order of per-chat setting keys in PATCH validation, diffs, and audit rows */
export const CHAT_SETTING_KEYS = [
    'model',
    'promptAddendum',
    'promptTemplateIds',
    'promptTemplatesAuto',
    'paused',
    'settingsLocked',
    'toolOverrides',
    'geminiPriority',
    'thinkingEffort',
    'richReplies',
] as const;

export type ChatSettingKey = (typeof CHAT_SETTING_KEYS)[number];

const CHAT_SETTING_KEY_SET: ReadonlySet<string> = new Set(CHAT_SETTING_KEYS);

export const isChatSettingKey = (key: string): key is ChatSettingKey => CHAT_SETTING_KEY_SET.has(key);

/** Chinese display label for every per-chat setting key */
export const CHAT_SETTING_LABELS: Readonly<Record<ChatSettingKey, string>> = {
    model: '模型',
    promptAddendum: '附加提示词',
    promptTemplateIds: '模板启用',
    promptTemplatesAuto: '自动加载模板',
    paused: '暂停',
    settingsLocked: '锁定设置',
    toolOverrides: '工具开关',
    geminiPriority: 'Priority PayGo',
    thinkingEffort: '思考等级',
    richReplies: '富文本回复',
};
