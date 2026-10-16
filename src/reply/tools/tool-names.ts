/**
 * Names of the reply-layer tools. MCP tools are renamed around them, and
 * DISABLED_TOOLS switches them off by these names.
 */
export const SEND_SMS_TOOL_NAME = 'send_sms_to_owner';
export const GENERATE_IMAGE_TOOL_NAME = 'generate_image';

/** Built-in names an MCP tool may never take */
export const RESERVED_TOOL_NAMES: readonly string[] = [SEND_SMS_TOOL_NAME, GENERATE_IMAGE_TOOL_NAME];
