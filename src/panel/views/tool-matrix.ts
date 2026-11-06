/**
 * The dashboard's read-only tool matrix: for a chat's current model, which
 * built-in tools a plain turn (no gs:// media) is offered, and in plain words
 * why the others are not.
 *
 * `enabled` always comes from resolveToolAvailability, the reply path's own
 * decision. The reasons below only explain it, re-reading the same config;
 * when they disagree the flag wins and the reason falls back to a generic one.
 */
import { getModelCapabilities } from '../../ai/platform-factory.js';
import { isTestInstance } from '../../config/instance.js';
import { getToolConfig, type ToolConfig } from '../../config/tool-config.js';
import { resolveToolAvailability, type ToolAvailability } from '../../reply/tools/tool-availability.js';
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
} from '../../reply/tools/tool-names.js';

export interface ToolMatrixEntry {
    name: string;
    enabled: boolean;
    /** Why it is off; null when enabled */
    reason: string | null;
}

/** Facts every reason check reads */
interface ReasonContext {
    config: ToolConfig;
    chatId: number;
    availability: ToolAvailability;
    supportsImageInput: boolean;
}

/** The first reason that applies, or null */
type ReasonCheck = (context: ReasonContext) => string | null;

interface ToolRow {
    name: string;
    isEnabled: (availability: ToolAvailability) => boolean;
    /** Tool-specific reasons, after the shared ones */
    reasons: readonly ReasonCheck[];
}

const GENERIC_REASON = '当前配置下未启用';

const disabledByName =
    (name: string): ReasonCheck =>
    ({ config }) =>
        config.disabledTools.has(name) ? `${name} 已在 DISABLED_TOOLS 中关闭` : null;

const needsToolChat: ReasonCheck = ({ config, chatId }) =>
    config.toolChatIds.has(chatId) ? null : '本聊天不在 TOOL_CHAT_IDS 中';

const needsHistoryChat: ReasonCheck = ({ config, chatId }) =>
    config.historyChatIds.has(chatId) ? null : '本聊天不在 HISTORY_CHAT_IDS 中';

const needsImageTools: ReasonCheck = ({ config }) => (config.imageTools ? null : 'IMAGE_TOOLS 为 0');

const needsHistorySwitch: ReasonCheck = ({ config }) => {
    if (!config.historyTools) return 'HISTORY_TOOLS 为 0';
    return config.historyBaseUrl === '' ? 'LUOXU_PREVIEW_URL 未配置' : null;
};

const needsHarnessSwitch: ReasonCheck = ({ config }) => (config.harnessIssues ? null : 'HARNESS_ISSUES 为 0');

const TOOL_ROWS: readonly ToolRow[] = [
    {
        name: SEND_SMS_TOOL_NAME,
        isEnabled: (availability) => availability.sms,
        reasons: [
            needsToolChat,
            ({ config }) => (config.ownerSmsUrl === '' ? 'OWNER_SMS_MCP_URL 未配置' : null),
            ({ config }) =>
                isTestInstance() && !config.ownerSmsAllowTest ? '测试实例未开启 OWNER_SMS_ALLOW_TEST' : null,
        ],
    },
    {
        name: GENERATE_IMAGE_TOOL_NAME,
        isEnabled: (availability) => availability.image,
        reasons: [needsToolChat, disabledByName(SEND_IMAGE_TOOL_NAME)],
    },
    {
        name: SEARCH_IMAGES_TOOL_NAME,
        isEnabled: (availability) => availability.imageSearch,
        reasons: [
            needsToolChat,
            needsImageTools,
            ({ config }) => (config.imageSearchUrl === '' ? 'IMAGE_SEARCH_URL 未配置' : null),
            disabledByName(SEND_IMAGE_TOOL_NAME),
        ],
    },
    {
        name: FETCH_IMAGE_TOOL_NAME,
        isEnabled: (availability) => availability.imageFetch,
        reasons: [
            ({ availability }) => (availability.imageSearch ? null : '依赖 search_images，后者未启用'),
            ({ supportsImageInput }) => (supportsImageInput ? null : '当前模型不支持图片输入'),
        ],
    },
    {
        name: SEND_IMAGE_TOOL_NAME,
        isEnabled: (availability) => availability.sendImage,
        reasons: [
            needsToolChat,
            ({ availability }) =>
                availability.image || availability.imageSearch ? null : '仅在 generate_image 或 search_images 可用时提供',
        ],
    },
    {
        name: SEARCH_BY_IMAGE_TOOL_NAME,
        isEnabled: (availability) => availability.imageReverseSearch,
        reasons: [
            needsToolChat,
            needsImageTools,
            ({ config }) => (config.imageReverseSearch ? null : 'IMAGE_REVERSE_SEARCH 为 0'),
        ],
    },
    {
        name: SEND_STICKER_TOOL_NAME,
        isEnabled: (availability) => availability.sticker,
        reasons: [
            needsToolChat,
            ({ config }) => (config.stickerTools ? null : 'STICKER_TOOLS 为 0'),
            ({ config }) => (config.stickerSetName === '' ? 'STICKER_SET_NAME 未配置' : null),
        ],
    },
    {
        name: SEND_FILE_TOOL_NAME,
        isEnabled: (availability) => availability.file,
        reasons: [needsToolChat, ({ config }) => (config.fileTools ? null : 'FILE_TOOLS 为 0')],
    },
    {
        name: SEARCH_HISTORY_TOOL_NAME,
        isEnabled: (availability) => availability.history,
        reasons: [needsHistoryChat, needsHistorySwitch, disabledByName(READ_HISTORY_TOOL_NAME)],
    },
    {
        name: READ_HISTORY_TOOL_NAME,
        isEnabled: (availability) => availability.history,
        reasons: [needsHistoryChat, needsHistorySwitch, disabledByName(SEARCH_HISTORY_TOOL_NAME)],
    },
    {
        name: LIST_HARNESS_ISSUES_TOOL_NAME,
        isEnabled: (availability) => availability.harnessIssues,
        reasons: [needsToolChat, needsHarnessSwitch, disabledByName(CREATE_HARNESS_ISSUE_TOOL_NAME)],
    },
    {
        name: CREATE_HARNESS_ISSUE_TOOL_NAME,
        isEnabled: (availability) => availability.harnessIssues,
        reasons: [needsToolChat, needsHarnessSwitch, disabledByName(LIST_HARNESS_ISSUES_TOOL_NAME)],
    },
];

const firstReason = (checks: readonly ReasonCheck[], context: ReasonContext): string | null => {
    for (const check of checks) {
        const reason = check(context);
        if (reason !== null) return reason;
    }
    return null;
};

/** One row per built-in tool, in a fixed order */
export const buildToolMatrix = (model: string, chatId: number): ToolMatrixEntry[] => {
    const config = getToolConfig();
    const capabilities = getModelCapabilities(model);
    const availability = resolveToolAvailability(model, chatId, config);
    const context: ReasonContext = {
        config,
        chatId,
        availability,
        supportsImageInput: capabilities.supportsImageInput,
    };
    const modelReason = capabilities.supportsClientTools === true ? null : '当前模型不支持客户端工具';

    return TOOL_ROWS.map((row) => {
        const enabled = row.isEnabled(availability);
        if (enabled) return { name: row.name, enabled, reason: null };
        const reason =
            modelReason ?? firstReason([disabledByName(row.name), ...row.reasons], context) ?? GENERIC_REASON;
        return { name: row.name, enabled, reason };
    });
};
