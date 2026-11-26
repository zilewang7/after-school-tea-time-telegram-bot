/**
 * Canonical per-chat tool switch groups shared by the backend and Mini App.
 *
 * Pure TypeScript with zero Node/DOM/external dependencies so both `src/` and
 * `webapp/src/` import from this single source of truth. Adding a key to
 * `TOOL_GROUP_KEYS` enforces compile-time completeness on labels, hints, and
 * any exhaustive consumers.
 */

export const TOOL_GROUP_KEYS = [
    'sms',
    'image',
    'imageSearch',
    'imageFetch',
    'imageReverseSearch',
    'sticker',
    'file',
    'history',
    'harnessIssues',
    // Phase 0 gray: the whole widget pair is one switch
    'widget',
    // New groups are appended, never inserted: this order is the canonical
    // JSON/audit order, and stored overrides of older key sets stay valid
    'workspace',
    // Free per-chat reaction tool: on everywhere unless the panel turns it off
    'reaction',
    // On-demand repository skill catalog and load_skill tool
    'skills',
] as const;

export type ToolGroupKey = (typeof TOOL_GROUP_KEYS)[number];

/** true = on for this chat, false = off, missing key = follow the env whitelist */
export type ToolOverrides = Partial<Record<ToolGroupKey, boolean>>;

/** Canonical display and serialization order of tool groups */
export const TOOL_GROUP_ORDER: readonly ToolGroupKey[] = TOOL_GROUP_KEYS;

const TOOL_GROUP_KEY_SET: ReadonlySet<string> = new Set(TOOL_GROUP_KEYS);

export const isToolGroupKey = (key: string): key is ToolGroupKey => TOOL_GROUP_KEY_SET.has(key);

/** Chinese display label of every tool group */
export const TOOL_GROUP_LABELS: Readonly<Record<ToolGroupKey, string>> = {
    sms: '发送短信',
    image: '生成图片',
    imageSearch: '搜索网络图片',
    imageFetch: '读取图片',
    imageReverseSearch: '以图搜图',
    sticker: '发送贴纸',
    file: '发送文件',
    history: '历史检索',
    harnessIssues: 'Issue 工具',
    widget: '聊天卡片',
    workspace: '工作区',
    reaction: '消息 reaction',
    skills: '技能规范',
};

/** What each group does that the owner may care about; shown under the panel row */
export const TOOL_GROUP_HINTS: Readonly<Record<ToolGroupKey, string>> = {
    sms: '开启后本聊天成员可让 bot 给机主发短信',
    image: '开启后本聊天可以画图并发送，会产生模型费用',
    imageSearch: '开启后本聊天可以搜索网络图片并发送',
    imageFetch: '开启后本聊天可以让模型拉取图片链接查看原图',
    imageReverseSearch: '开启后本聊天可以用图片搜索来源（Yandex，二次元补充 SauceNAO）',
    sticker: '开启后本聊天可以发贴纸包里的贴纸',
    file: '开启后本聊天可以把长文本写成文件发出',
    history: '开启后本聊天可以检索 luoxu 的历史归档',
    harnessIssues: '开启后模型可以把使用中遇到的问题记成 issue',
    widget: '开启后模型可在回复里附一张 A2UI/HTML 卡片（群聊会发一条带预览的 Mini App 链接）',
    workspace: '开启后模型可以在本会话的草稿区里写、读、改、删文件，7 天未使用自动清理',
    reaction: '开启后模型可以给本聊天里的消息点一个 emoji reaction',
    skills: '开启后模型可按需加载仓库内的工具使用规范（仅在存在可用技能时生效）',
};

export const toolGroupLabelOf = (key: ToolGroupKey): string => TOOL_GROUP_LABELS[key];

export const toolGroupHintOf = (key: ToolGroupKey): string | null => {
    const hint = TOOL_GROUP_HINTS[key];
    return hint === '' ? null : hint;
};
