/**
 * Which tools one turn gets — the only place DISABLED_TOOLS is applied.
 *
 * Decided from the model, the chat, startup configuration and the chat's panel
 * switches — never from what the messages say — so the same model in the same
 * chat with the same settings always declares the same tools, byte for byte
 * (implicit prompt caching), and the system prompt line about SMS is present
 * exactly when the tool is. The panel's per-chat switches override only the
 * chat whitelists; env kill switches, URLs, model capabilities and the test
 * instance's SMS guard remain hard prerequisites. One exception keeps the
 * byte-stability promise: a platform that sends requests carrying large media
 * without client tools (Gemini) gets none for such a turn.
 */
import { getModelCapabilities, getPlatform } from '../../ai/platform-factory.js';
import { listMcpServers } from '../../ai/mcp/index.js';
import { isTestInstance } from '../../config/instance.js';
import { getToolConfig, type ToolConfig } from '../../config/tool-config.js';
import { toolOverrideOf, type ToolGroupKey, type ToolOverrides } from '../../services/tool-overrides.js';
import {
    FETCH_IMAGE_TOOL_NAME,
    GENERATE_IMAGE_TOOL_NAME,
    SEARCH_IMAGES_TOOL_NAME,
    SEARCH_BY_IMAGE_TOOL_NAME,
    SEND_FILE_TOOL_NAME,
    SEND_IMAGE_TOOL_NAME,
    SEND_SMS_TOOL_NAME,
    SEND_STICKER_TOOL_NAME,
    SEARCH_HISTORY_TOOL_NAME,
    READ_HISTORY_TOOL_NAME,
    LIST_HARNESS_ISSUES_TOOL_NAME,
    CREATE_HARNESS_ISSUE_TOOL_NAME,
    SEND_WIDGET_TOOL_NAME,
    GET_UI_GUIDE_TOOL_NAME,
} from './tool-names.js';

/** What the turn's request carries, as far as tool availability cares */
export interface ToolRequestTraits {
    /** The context references large media (gs:// URIs) */
    readonly carriesLargeMedia: boolean;
}

const PLAIN_REQUEST: ToolRequestTraits = { carriesLargeMedia: false };

export interface ToolAvailability {
    /** Connected MCP servers this turn draws tools from, in config order */
    readonly mcpServers: readonly string[];
    /** Whether an MCP tool, by its original MCP name, is left on */
    readonly isMcpToolEnabled: (toolName: string) => boolean;
    /** send_sms_to_owner is offered */
    readonly sms: boolean;
    /** generate_image is offered (it delivers through send_image) */
    readonly image: boolean;
    /** search_images is offered (text-only models may still pick and send) */
    readonly imageSearch: boolean;
    /** send_image is offered: the delivery path of a searched or drawn picture */
    readonly sendImage: boolean;
    /** search_by_image is offered */
    readonly imageReverseSearch: boolean;
    /** fetch_image is offered: only models that can see what they read */
    readonly imageFetch: boolean;
    /** send_sticker is offered */
    readonly sticker: boolean;
    /** send_file is offered */
    readonly file: boolean;
    /** search_history / read_history are offered (this chat is archived by luoxu) */
    readonly history: boolean;
    /** list_harness_issues / create_harness_issue are offered */
    readonly harnessIssues: boolean;
    /** send_widget is offered (WIDGET_ENABLE + widget chat whitelist) */
    readonly widget: boolean;
    /** get_ui_guide is offered (only together with send_widget) */
    readonly widgetGuide: boolean;
}

const NO_TOOLS: ToolAvailability = {
    mcpServers: [],
    isMcpToolEnabled: () => false,
    sms: false,
    image: false,
    imageSearch: false,
    sendImage: false,
    imageReverseSearch: false,
    imageFetch: false,
    sticker: false,
    file: false,
    history: false,
    harnessIssues: false,
    widget: false,
    widgetGuide: false,
};

export const resolveToolAvailability = (
    model: string,
    chatId: number,
    config: ToolConfig = getToolConfig(),
    request: ToolRequestTraits = PLAIN_REQUEST,
    overrides: ToolOverrides | null = null
): ToolAvailability => {
    const capabilities = getModelCapabilities(model);
    if (capabilities.supportsClientTools !== true) return NO_TOOLS;
    // The request will declare no tools, so the prompt must not name any
    if (request.carriesLargeMedia && capabilities.clientToolsWithLargeMedia === false) return NO_TOOLS;

    const isEnabled = (name: string): boolean => !config.disabledTools.has(name);
    const platformType = getPlatform(model).type;
    // Widget tools are off unless WIDGET_ENABLE=1, the chat is whitelisted (an
    // empty WIDGET_CHAT_IDS follows the normal tool whitelist) and the chat can
    // receive the card: a private chat gets the native widget, a group gets the
    // Mini App link fallback (Telegram still rejects widgets in groups), which
    // needs both WIDGET_GROUP_FALLBACK and the share pages as its preview
    // landing spot. The panel may override the whitelist part, never the env
    // switches or the chat kind.
    const widgetChats = config.widgetChatIds.size > 0 ? config.widgetChatIds : config.toolChatIds;
    const linkFallbackReady = config.widgetGroupFallback && config.shareEnabled;
    const chatCanReceiveWidget = chatId > 0 || linkFallbackReady;
    const widget =
        config.widgetEnabled &&
        chatCanReceiveWidget &&
        (toolOverrideOf(overrides, 'widget') ?? widgetChats.has(chatId)) &&
        isEnabled(SEND_WIDGET_TOOL_NAME) &&
        isEnabled(GET_UI_GUIDE_TOOL_NAME);

    // A server is out when excluded for this platform, disabled by its key, or
    // left with no enabled tool
    const mcpServers = listMcpServers()
        .filter((server) => !(server.config.excludePlatforms ?? []).includes(platformType))
        .filter((server) => isEnabled(server.name))
        .filter((server) => server.tools.some((tool) => isEnabled(tool.name)))
        .map((server) => server.name);

    // The one layer the panel may override: which chats are offered the tools
    // with side effects. Everything else below stays a hard prerequisite.
    const sideEffectGate = (key: ToolGroupKey): boolean =>
        toolOverrideOf(overrides, key) ?? config.toolChatIds.has(chatId);
    // The test instance inherits the production env, so it must opt in to SMS
    const smsInstanceAllowed = !isTestInstance() || config.ownerSmsAllowTest;

    // History is read-only, so it follows its own chat list rather than the
    // side-effecting TOOL_CHAT_IDS: bilibili-archive chats can still be searched.
    // The owner's private chat has no archive of its own but may search every
    // archived group (scope=all), so it gets the tools without an env entry.
    const ownerDmChat =
        config.owner.userId !== null &&
        chatId > 0 &&
        Number.parseInt(config.owner.userId, 10) === chatId;
    const historyAllowed =
        (toolOverrideOf(overrides, 'history') ??
            (config.historyChatIds.has(chatId) || ownerDmChat)) &&
        config.historyTools &&
        config.historyBaseUrl !== '' &&
        isEnabled(SEARCH_HISTORY_TOOL_NAME) &&
        isEnabled(READ_HISTORY_TOOL_NAME);

    // Media tools follow generate_image's scope: same chats, same switch.
    // send_image is the only way a picture reaches the chat — a drawn one
    // included — so it is offered whenever searching or drawing is.
    const sendImageEnabled = isEnabled(SEND_IMAGE_TOOL_NAME);
    const wantsSearchImages =
        sideEffectGate('imageSearch') &&
        config.imageTools &&
        config.imageSearchUrl !== '' &&
        isEnabled(SEARCH_IMAGES_TOOL_NAME);
    const wantsGenerateImage = sideEffectGate('image') && isEnabled(GENERATE_IMAGE_TOOL_NAME);
    const imageSearch = wantsSearchImages && sendImageEnabled;
    const image = wantsGenerateImage && sendImageEnabled;

    return {
        mcpServers,
        isMcpToolEnabled: isEnabled,
        sms:
            sideEffectGate('sms') &&
            config.ownerSmsUrl !== '' &&
            smsInstanceAllowed &&
            isEnabled(SEND_SMS_TOOL_NAME),
        image,
        imageSearch,
        sendImage: sendImageEnabled && (image || imageSearch),
        imageReverseSearch:
            sideEffectGate('imageReverseSearch') &&
            config.imageTools &&
            config.imageReverseSearch &&
            isEnabled(SEARCH_BY_IMAGE_TOOL_NAME),
        // Reading a picture is only useful to a model that can see it; the panel
        // may switch it off, but cannot switch it on without search_images
        imageFetch:
            imageSearch &&
            toolOverrideOf(overrides, 'imageFetch') !== false &&
            capabilities.supportsImageInput &&
            isEnabled(FETCH_IMAGE_TOOL_NAME),
        sticker:
            sideEffectGate('sticker') &&
            config.stickerTools &&
            config.stickerSetName !== '' &&
            isEnabled(SEND_STICKER_TOOL_NAME),
        file: sideEffectGate('file') && config.fileTools && isEnabled(SEND_FILE_TOOL_NAME),
        history: historyAllowed,
        // Self-reporting is chat-scoped like the other side-effecting tools: it
        // writes a row, and the row is about this deployment, not the user.
        harnessIssues:
            sideEffectGate('harnessIssues') &&
            config.harnessIssues &&
            isEnabled(LIST_HARNESS_ISSUES_TOOL_NAME) &&
            isEnabled(CREATE_HARNESS_ISSUE_TOOL_NAME),
        widget,
        widgetGuide: widget,
    };
};
