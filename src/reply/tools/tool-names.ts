/**
 * Names of the reply-layer tools. MCP tools are renamed around them, and
 * DISABLED_TOOLS switches them off by these names.
 */
export const SEND_SMS_TOOL_NAME = 'send_sms_to_owner';
export const GENERATE_IMAGE_TOOL_NAME = 'generate_image';
export const SEARCH_IMAGES_TOOL_NAME = 'search_images';
export const FETCH_IMAGE_TOOL_NAME = 'fetch_image';
export const SEND_IMAGE_TOOL_NAME = 'send_image';
export const SEARCH_BY_IMAGE_TOOL_NAME = 'search_by_image';
export const SEND_STICKER_TOOL_NAME = 'send_sticker';

/** Built-in names an MCP tool may never take */
export const RESERVED_TOOL_NAMES: readonly string[] = [
    SEND_SMS_TOOL_NAME,
    GENERATE_IMAGE_TOOL_NAME,
    SEARCH_IMAGES_TOOL_NAME,
    FETCH_IMAGE_TOOL_NAME,
    SEND_IMAGE_TOOL_NAME,
    SEARCH_BY_IMAGE_TOOL_NAME,
    SEND_STICKER_TOOL_NAME,
];
