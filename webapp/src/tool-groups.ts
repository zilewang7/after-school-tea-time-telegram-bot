/**
 * The ten tool groups of the panel's per-chat switches: labels and the
 * canonical order (the server returns the groups in the same order). Also the
 * parser for the audit's canonical JSON value.
 */
import type { ToolGroupKey, ToolOverrides } from './api';

export const TOOL_GROUP_ORDER: readonly ToolGroupKey[] = [
    'sms',
    'image',
    'imageSearch',
    'imageFetch',
    'imageReverseSearch',
    'sticker',
    'file',
    'history',
    'harnessIssues',
    'widget',
];

const TOOL_GROUP_LABELS: Record<ToolGroupKey, string> = {
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
};

export const toolGroupLabelOf = (key: ToolGroupKey): string => TOOL_GROUP_LABELS[key];

/** What each group does that the owner may care about; shown under the row */
const TOOL_GROUP_HINTS: Partial<Record<ToolGroupKey, string>> = {
    sms: '开启后本聊天成员可让 bot 给机主发短信',
    image: '开启后本聊天可以画图并发送，会产生模型费用',
    imageSearch: '开启后本聊天可以搜索网络图片并发送',
    imageReverseSearch: '开启后本聊天可以用图片搜索来源（Yandex）',
    sticker: '开启后本聊天可以发贴纸包里的贴纸',
    file: '开启后本聊天可以把长文本写成文件发出',
    history: '开启后本聊天可以检索 luoxu 的历史归档',
    harnessIssues: '开启后模型可以把使用中遇到的问题记成 issue',
    widget: '开启后模型可在回复里附一张 A2UI/HTML 卡片（群聊会发一条带预览的 Mini App 链接）',
};

export const toolGroupHintOf = (key: ToolGroupKey): string | null => TOOL_GROUP_HINTS[key] ?? null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** The audit stores canonical JSON; null when absent or unreadable */
export const parseToolOverridesJson = (text: string | null): ToolOverrides | null => {
    if (text === null) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (!isRecord(parsed)) return null;
    const overrides: ToolOverrides = {};
    for (const key of TOOL_GROUP_ORDER) {
        const value = parsed[key];
        if (typeof value === 'boolean') overrides[key] = value;
    }
    return overrides;
};
