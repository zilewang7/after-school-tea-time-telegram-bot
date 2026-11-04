/**
 * Which tools one turn gets — the only place DISABLED_TOOLS is applied.
 *
 * Decided from the model, the chat and startup configuration — never from
 * what the messages say — so the same model in the same chat always declares
 * the same tools, byte for byte (implicit prompt caching), and the system
 * prompt line about SMS is present exactly when the tool is. One exception
 * keeps that last promise: a platform that sends requests carrying large
 * media without client tools (Gemini) gets none for such a turn.
 */
import { getModelCapabilities, getPlatform } from '../../ai/platform-factory.js';
import { listMcpServers } from '../../ai/mcp/index.js';
import { isTestInstance } from '../../config/instance.js';
import { getToolConfig, type ToolConfig } from '../../config/tool-config.js';
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
};

export const resolveToolAvailability = (
    model: string,
    chatId: number,
    config: ToolConfig = getToolConfig(),
    request: ToolRequestTraits = PLAIN_REQUEST
): ToolAvailability => {
    const capabilities = getModelCapabilities(model);
    if (capabilities.supportsClientTools !== true) return NO_TOOLS;
    // The request will declare no tools, so the prompt must not name any
    if (request.carriesLargeMedia && capabilities.clientToolsWithLargeMedia === false) return NO_TOOLS;

    const isEnabled = (name: string): boolean => !config.disabledTools.has(name);
    const platformType = getPlatform(model).type;

    // A server is out when excluded for this platform, disabled by its key, or
    // left with no enabled tool
    const mcpServers = listMcpServers()
        .filter((server) => !(server.config.excludePlatforms ?? []).includes(platformType))
        .filter((server) => isEnabled(server.name))
        .filter((server) => server.tools.some((tool) => isEnabled(tool.name)))
        .map((server) => server.name);

    // The tools with side effects are only offered in the whitelisted chats
    const chatAllowed = config.toolChatIds.has(chatId);
    // The test instance inherits the production env, so it must opt in to SMS
    const smsInstanceAllowed = !isTestInstance() || config.ownerSmsAllowTest;

    // History is read-only, so it follows its own chat list rather than the
    // side-effecting TOOL_CHAT_IDS: bilibili-archive chats can still be searched.
    const historyAllowed =
        config.historyTools &&
        config.historyBaseUrl !== '' &&
        config.historyChatIds.has(chatId) &&
        isEnabled(SEARCH_HISTORY_TOOL_NAME) &&
        isEnabled(READ_HISTORY_TOOL_NAME);

    // Media tools follow generate_image's scope: same chats, same switch.
    // send_image is the only way a picture reaches the chat — a drawn one
    // included — so it is offered whenever searching or drawing is.
    const wantsSendImage = chatAllowed && isEnabled(SEND_IMAGE_TOOL_NAME);
    const wantsSearchImages =
        chatAllowed && config.imageTools && config.imageSearchUrl !== '' && isEnabled(SEARCH_IMAGES_TOOL_NAME);
    const wantsGenerateImage = chatAllowed && isEnabled(GENERATE_IMAGE_TOOL_NAME);
    const imageSearch = wantsSearchImages && wantsSendImage;
    const image = wantsGenerateImage && wantsSendImage;

    return {
        mcpServers,
        isMcpToolEnabled: isEnabled,
        sms:
            chatAllowed &&
            config.ownerSmsUrl !== '' &&
            smsInstanceAllowed &&
            isEnabled(SEND_SMS_TOOL_NAME),
        image,
        imageSearch,
        sendImage: wantsSendImage && (image || imageSearch),
        imageReverseSearch:
            chatAllowed &&
            config.imageTools &&
            config.imageReverseSearch &&
            isEnabled(SEARCH_BY_IMAGE_TOOL_NAME),
        // Reading a picture is only useful to a model that can see it
        imageFetch: imageSearch && capabilities.supportsImageInput && isEnabled(FETCH_IMAGE_TOOL_NAME),
        sticker:
            chatAllowed &&
            config.stickerTools &&
            config.stickerSetName !== '' &&
            isEnabled(SEND_STICKER_TOOL_NAME),
        file: chatAllowed && config.fileTools && isEnabled(SEND_FILE_TOOL_NAME),
        history: historyAllowed,
    };
};
