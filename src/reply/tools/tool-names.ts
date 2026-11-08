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
export const SEND_FILE_TOOL_NAME = 'send_file';
export const SEND_WIDGET_TOOL_NAME = 'send_widget';
export const GET_UI_GUIDE_TOOL_NAME = 'get_ui_guide';
export const SEARCH_HISTORY_TOOL_NAME = 'search_history';
export const READ_HISTORY_TOOL_NAME = 'read_history';
export const LIST_HARNESS_ISSUES_TOOL_NAME = 'list_harness_issues';
export const CREATE_HARNESS_ISSUE_TOOL_NAME = 'create_harness_issue';

/** Built-in names an MCP tool may never take */
export const RESERVED_TOOL_NAMES: readonly string[] = [
    SEND_SMS_TOOL_NAME,
    GENERATE_IMAGE_TOOL_NAME,
    SEARCH_IMAGES_TOOL_NAME,
    FETCH_IMAGE_TOOL_NAME,
    SEND_IMAGE_TOOL_NAME,
    SEARCH_BY_IMAGE_TOOL_NAME,
    SEND_STICKER_TOOL_NAME,
    SEND_FILE_TOOL_NAME,
    SEND_WIDGET_TOOL_NAME,
    GET_UI_GUIDE_TOOL_NAME,
    SEARCH_HISTORY_TOOL_NAME,
    READ_HISTORY_TOOL_NAME,
    LIST_HARNESS_ISSUES_TOOL_NAME,
    CREATE_HARNESS_ISSUE_TOOL_NAME,
];
