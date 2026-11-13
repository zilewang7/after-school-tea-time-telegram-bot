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
export const WORKSPACE_WRITE_TOOL_NAME = 'workspace_write';
export const WORKSPACE_READ_TOOL_NAME = 'workspace_read';
export const WORKSPACE_LIST_TOOL_NAME = 'workspace_list';
export const WORKSPACE_FIND_TOOL_NAME = 'workspace_find';
export const WORKSPACE_EDIT_TOOL_NAME = 'workspace_edit';
export const WORKSPACE_COPY_TOOL_NAME = 'workspace_copy';
export const WORKSPACE_DELETE_TOOL_NAME = 'workspace_delete';
export const WORKSPACE_PREVIEW_TOOL_NAME = 'workspace_preview';
export const LEAVE_HANDOFF_TOOL_NAME = 'leave_handoff';

/**
 * The "product" tools: they produce or deliver what the reply exists to hand
 * over (a picture, a sticker, a file, a card). Their run time does not count
 * against the reply's tool clock, and once the clock is up they stay callable,
 * so a reply never ends unable to hand over what it made.
 */
export const PRODUCT_TOOL_NAMES: ReadonlySet<string> = new Set([
    GENERATE_IMAGE_TOOL_NAME,
    SEND_IMAGE_TOOL_NAME,
    SEND_STICKER_TOOL_NAME,
    SEND_FILE_TOOL_NAME,
    SEND_WIDGET_TOOL_NAME,
]);

/**
 * The workspace file tools: one group, always offered together (the static
 * prompt lists them in one line). `workspace_preview` is separate because it
 * needs a vision model and the render sidecar. `leave_handoff` is deliberately
 * not part of it: it is offered whenever the workspace is, but turning it off
 * must not turn the whole workspace off.
 */
export const WORKSPACE_FILE_TOOL_NAMES: readonly string[] = [
    WORKSPACE_WRITE_TOOL_NAME,
    WORKSPACE_READ_TOOL_NAME,
    WORKSPACE_LIST_TOOL_NAME,
    WORKSPACE_FIND_TOOL_NAME,
    WORKSPACE_EDIT_TOOL_NAME,
    WORKSPACE_COPY_TOOL_NAME,
    WORKSPACE_DELETE_TOOL_NAME,
];

/**
 * Tools whose handler time does not count against the reply's tool budget.
 *
 * They cost the reply nothing: the product tools hand over what the reply made
 * (a picture, a sticker, a file, a card), the workspace tools let it finish and
 * preview the draft it is about to hand over, the harness issue tools only
 * write a local row, and `get_ui_guide` only reads a static guide (the
 * prerequisite for a card). None of them spends the budget on looking around,
 * so the reply is never unable to deliver or to report a problem because its
 * clock ran out. The same set is what a post-budget round still offers; the
 * round count there (FREE_TOOL_ROUNDS_MAX) is the bound.
 */
export const TIME_FREE_TOOL_NAMES: ReadonlySet<string> = new Set([
    ...PRODUCT_TOOL_NAMES,
    ...WORKSPACE_FILE_TOOL_NAMES,
    WORKSPACE_PREVIEW_TOOL_NAME,
    // It only writes one local row, and the Gemini loop may offer it in the
    // last round after every budget is gone. Adding it cannot flip the
    // no-cost/final split: it exists only while the workspace tools (all
    // time-free) are offered, so hasFreeTools is already true whenever it is.
    LEAVE_HANDOFF_TOOL_NAME,
    LIST_HARNESS_ISSUES_TOOL_NAME,
    CREATE_HARNESS_ISSUE_TOOL_NAME,
    GET_UI_GUIDE_TOOL_NAME,
]);

export const isTimeFreeToolName = (name: string): boolean => TIME_FREE_TOOL_NAMES.has(name);

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
    WORKSPACE_WRITE_TOOL_NAME,
    WORKSPACE_READ_TOOL_NAME,
    WORKSPACE_LIST_TOOL_NAME,
    WORKSPACE_FIND_TOOL_NAME,
    WORKSPACE_EDIT_TOOL_NAME,
    WORKSPACE_COPY_TOOL_NAME,
    WORKSPACE_DELETE_TOOL_NAME,
    WORKSPACE_PREVIEW_TOOL_NAME,
    LEAVE_HANDOFF_TOOL_NAME,
];
