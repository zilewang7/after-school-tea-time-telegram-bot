/**
 * The panel's tool matrix for one chat: the tool groups with the tools they
 * register, the effective state for the chat's current model and settings, the
 * panel's own switch, and — in plain words — why a group is off and whether a
 * switch could help.
 *
 * `enabled` / `defaultEnabled` always come from resolveToolAvailability, the
 * reply path's own decision. The reasons below only explain it, re-reading the
 * same config; when they disagree the flag wins and the reason falls back to a
 * generic one.
 */
import { getModelCapabilities } from '../../ai/platform-factory.js';
import { isTestInstance } from '../../config/instance.js';
import { getToolConfig, type ToolConfig } from '../../config/tool-config.js';
import { resolveToolAvailability, type ToolAvailability } from '../../reply/tools/tool-availability.js';
import type { AccessTier } from '../../services/access-tier.js';
import { TOOL_GROUP_KEYS, toolOverrideOf, type ToolGroupKey, type ToolOverrides } from '../../services/tool-overrides.js';
import {
    CREATE_HARNESS_ISSUE_TOOL_NAME,
    FETCH_IMAGE_TOOL_NAME,
    GENERATE_IMAGE_TOOL_NAME,
    LIST_HARNESS_ISSUES_TOOL_NAME,
    READ_HISTORY_TOOL_NAME,
    SEARCH_BY_IMAGE_TOOL_NAME,
    SEARCH_HISTORY_TOOL_NAME,
    SEARCH_IMAGES_TOOL_NAME,
    SEND_FILE_TOOL_NAME,
    SEND_IMAGE_TOOL_NAME,
    SEND_SMS_TOOL_NAME,
    SEND_STICKER_TOOL_NAME,
    SEND_WIDGET_TOOL_NAME,
    GET_UI_GUIDE_TOOL_NAME,
    WORKSPACE_WRITE_TOOL_NAME,
    WORKSPACE_READ_TOOL_NAME,
    WORKSPACE_LIST_TOOL_NAME,
    WORKSPACE_EDIT_TOOL_NAME,
    WORKSPACE_DELETE_TOOL_NAME,
    WORKSPACE_PREVIEW_TOOL_NAME,
} from '../../reply/tools/tool-names.js';

export interface ToolGroupEntry {
    key: ToolGroupKey;
    /** The tool names this group registers, in declaration order */
    tools: readonly string[];
    /** Offered to a plain turn (no gs:// media) with the chat's current settings */
    enabled: boolean;
    /** Offered if every switch followed the env again */
    defaultEnabled: boolean;
    /** The panel's switch; null = follow the env whitelist */
    override: boolean | null;
    /** Why it is off; null when enabled */
    reason: string | null;
    /** Off for a reason a switch cannot fix (env switch, URL, model capability) */
    blocked: boolean;
}

const GROUP_TOOLS: Record<ToolGroupKey, readonly string[]> = {
    sms: [SEND_SMS_TOOL_NAME],
    image: [GENERATE_IMAGE_TOOL_NAME, SEND_IMAGE_TOOL_NAME],
    imageSearch: [SEARCH_IMAGES_TOOL_NAME, SEND_IMAGE_TOOL_NAME],
    imageFetch: [FETCH_IMAGE_TOOL_NAME],
    imageReverseSearch: [SEARCH_BY_IMAGE_TOOL_NAME],
    sticker: [SEND_STICKER_TOOL_NAME],
    file: [SEND_FILE_TOOL_NAME],
    history: [SEARCH_HISTORY_TOOL_NAME, READ_HISTORY_TOOL_NAME],
    harnessIssues: [LIST_HARNESS_ISSUES_TOOL_NAME, CREATE_HARNESS_ISSUE_TOOL_NAME],
    widget: [SEND_WIDGET_TOOL_NAME, GET_UI_GUIDE_TOOL_NAME],
    workspace: [
        WORKSPACE_WRITE_TOOL_NAME,
        WORKSPACE_READ_TOOL_NAME,
        WORKSPACE_LIST_TOOL_NAME,
        WORKSPACE_EDIT_TOOL_NAME,
        WORKSPACE_DELETE_TOOL_NAME,
        WORKSPACE_PREVIEW_TOOL_NAME,
    ],
};

const ENABLED_OF: Record<ToolGroupKey, (availability: ToolAvailability) => boolean> = {
    sms: (availability) => availability.sms,
    image: (availability) => availability.image,
    imageSearch: (availability) => availability.imageSearch,
    imageFetch: (availability) => availability.imageFetch,
    imageReverseSearch: (availability) => availability.imageReverseSearch,
    sticker: (availability) => availability.sticker,
    file: (availability) => availability.file,
    history: (availability) => availability.history,
    harnessIssues: (availability) => availability.harnessIssues,
    widget: (availability) => availability.widget,
    workspace: (availability) => availability.workspace,
};

/** Facts every reason check reads */
interface ReasonContext {
    config: ToolConfig;
    chatId: number;
    /** The availability with the current switches, for dependency reasons */
    availability: ToolAvailability;
    supportsImageInput: boolean;
    testInstance: boolean;
    /** The requester's tier: a trial user loses SMS and MCP whatever the chat says */
    trial: boolean;
    /** Non-null when the model cannot call client tools at all */
    modelReason: string | null;
}

/** The first reason that applies, or null */
type ReasonCheck = (context: ReasonContext) => string | null;

const MODEL_REASON = '当前模型不支持客户端工具';
const TRIAL_REASON = '体验用户需要申请准入';
const disabledByName =
    (name: string): ReasonCheck =>
    ({ config }) =>
        config.disabledTools.has(name) ? `${name} 已在 DISABLED_TOOLS 中关闭` : null;

const IMAGE_TOOLS_OFF: ReasonCheck = ({ config }) => (config.imageTools ? null : 'IMAGE_TOOLS 为 0');

/** Hard prerequisites per group: reasons the panel switch cannot override */
const HARD_REASONS: Record<ToolGroupKey, readonly ReasonCheck[]> = {
    sms: [
        // A trial user has no SMS tool at all (design D3); the tier comes first
        // because no env switch or panel switch can turn it back on
        ({ trial }) => (trial ? TRIAL_REASON : null),
        disabledByName(SEND_SMS_TOOL_NAME),
        ({ config }) => (config.ownerSmsUrl === '' ? 'OWNER_SMS_MCP_URL 未配置' : null),
        ({ config, testInstance }) =>
            testInstance && !config.ownerSmsAllowTest ? '测试实例未开启 OWNER_SMS_ALLOW_TEST' : null,
    ],
    image: [disabledByName(GENERATE_IMAGE_TOOL_NAME), disabledByName(SEND_IMAGE_TOOL_NAME)],
    imageSearch: [
        IMAGE_TOOLS_OFF,
        ({ config }) => (config.imageSearchUrl === '' ? 'IMAGE_SEARCH_URL 未配置' : null),
        disabledByName(SEARCH_IMAGES_TOOL_NAME),
        disabledByName(SEND_IMAGE_TOOL_NAME),
    ],
    imageFetch: [
        ({ supportsImageInput }) => (supportsImageInput ? null : '当前模型不支持图片输入'),
        ({ availability }) => (availability.imageSearch ? null : '依赖搜索网络图片，后者未启用'),
        disabledByName(FETCH_IMAGE_TOOL_NAME),
    ],
    imageReverseSearch: [
        IMAGE_TOOLS_OFF,
        ({ config }) => (config.imageReverseSearch ? null : 'IMAGE_REVERSE_SEARCH 为 0'),
        disabledByName(SEARCH_BY_IMAGE_TOOL_NAME),
    ],
    sticker: [
        ({ config }) => (config.stickerTools ? null : 'STICKER_TOOLS 为 0'),
        ({ config }) => (config.stickerSetName === '' ? 'STICKER_SET_NAME 未配置' : null),
        disabledByName(SEND_STICKER_TOOL_NAME),
    ],
    file: [
        ({ config }) => (config.fileTools ? null : 'FILE_TOOLS 为 0'),
        disabledByName(SEND_FILE_TOOL_NAME),
    ],
    history: [
        ({ config }) => (config.historyTools ? null : 'HISTORY_TOOLS 为 0'),
        ({ config }) => (config.historyBaseUrl === '' ? 'LUOXU_PREVIEW_URL 未配置' : null),
        disabledByName(SEARCH_HISTORY_TOOL_NAME),
        disabledByName(READ_HISTORY_TOOL_NAME),
    ],
    harnessIssues: [
        ({ config }) => (config.harnessIssues ? null : 'HARNESS_ISSUES 为 0'),
        disabledByName(LIST_HARNESS_ISSUES_TOOL_NAME),
        disabledByName(CREATE_HARNESS_ISSUE_TOOL_NAME),
    ],
    widget: [
        ({ chatId }) => (chatId > 0 ? null : '群聊暂不支持聊天卡片（Telegram 服务端限制）'),
        ({ config }) => (config.widgetEnabled ? null : 'WIDGET_ENABLE 为 0'),
        disabledByName(SEND_WIDGET_TOOL_NAME),
        disabledByName(GET_UI_GUIDE_TOOL_NAME),
    ],
    workspace: [
        ({ config }) => (config.workspaceEnabled ? null : 'WORKSPACE_ENABLE 为 0'),
        disabledByName(WORKSPACE_WRITE_TOOL_NAME),
        disabledByName(WORKSPACE_READ_TOOL_NAME),
        disabledByName(WORKSPACE_LIST_TOOL_NAME),
        disabledByName(WORKSPACE_EDIT_TOOL_NAME),
        disabledByName(WORKSPACE_DELETE_TOOL_NAME),
    ],
};

/** Why the env whitelist keeps a group off; the panel switch may turn it on */
const whitelistReasonOf = (key: ToolGroupKey): string => {
    if (key === 'history') return '本聊天不在 HISTORY_CHAT_IDS 中';
    if (key === 'widget') return '本聊天不在 WIDGET_CHAT_IDS / TOOL_CHAT_IDS 中';
    if (key === 'workspace') return '本聊天不在 WORKSPACE_CHAT_IDS / TOOL_CHAT_IDS 中';
    return '本聊天不在 TOOL_CHAT_IDS 中';
};

const firstReason = (checks: readonly ReasonCheck[], context: ReasonContext): string | null => {
    for (const check of checks) {
        const reason = check(context);
        if (reason !== null) return reason;
    }
    return null;
};

/** Why one group is off, and whether flipping the switch could change that */
const explain = (entry: ToolGroupEntry, context: ReasonContext): { reason: string | null; blocked: boolean } => {
    if (entry.enabled) return { reason: null, blocked: false };
    const hardReason = context.modelReason ?? firstReason(HARD_REASONS[entry.key], context);
    if (hardReason !== null) return { reason: hardReason, blocked: true };
    if (entry.override === false) return { reason: '已由面板关闭', blocked: false };
    return { reason: whitelistReasonOf(entry.key), blocked: false };
};

/** One entry per tool group, in the fixed group order */
export const buildToolMatrix = (
    model: string,
    chatId: number,
    overrides: ToolOverrides | null = null,
    access: AccessTier = 'full'
): ToolGroupEntry[] => {
    const config = getToolConfig();
    const capabilities = getModelCapabilities(model);
    // The tier rides along into both variants: a trial user has no SMS/MCP even
    // when every switch follows the env again
    const availability = resolveToolAvailability(model, chatId, config, undefined, overrides, access);
    const envAvailability = resolveToolAvailability(model, chatId, config, undefined, null, access);
    const context: ReasonContext = {
        config,
        chatId,
        availability,
        supportsImageInput: capabilities.supportsImageInput,
        testInstance: isTestInstance(),
        trial: availability.trial,
        modelReason: capabilities.supportsClientTools === true ? null : MODEL_REASON,
    };

    return TOOL_GROUP_KEYS.map((key) => {
        const entry: ToolGroupEntry = {
            key,
            tools: GROUP_TOOLS[key],
            enabled: ENABLED_OF[key](availability),
            defaultEnabled: ENABLED_OF[key](envAvailability),
            override: toolOverrideOf(overrides, key),
            reason: null,
            blocked: false,
        };
        return { ...entry, ...explain(entry, context) };
    });
};
