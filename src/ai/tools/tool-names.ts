/**
 * Names of the 16 built-in reply-layer tools and the time-free classification
 * used by the AI tool loops. MCP tools are renamed around them, and
 * DISABLED_TOOLS switches them off by these names.
 */
export const SEND_SMS_TOOL_NAME = 'send_sms_to_owner';
export const GENERATE_IMAGE_TOOL_NAME = 'generate_image';
export const FIND_IMAGE_TOOL_NAME = 'find_image';
export const FETCH_IMAGE_TOOL_NAME = 'fetch_image';
export const CROP_IMAGE_TOOL_NAME = 'crop_image';
export const EXTRACT_FRAMES_TOOL_NAME = 'extract_frames';
export const SEND_IMAGE_TOOL_NAME = 'send_image';
export const SEND_STICKER_TOOL_NAME = 'send_sticker';
export const SEND_FILE_TOOL_NAME = 'send_file';
export const SEND_WIDGET_TOOL_NAME = 'send_widget';
export const WORKSPACE_TOOL_NAME = 'workspace';
export const LEAVE_HANDOFF_TOOL_NAME = 'leave_handoff';
export const HISTORY_TOOL_NAME = 'history';
export const HARNESS_ISSUE_TOOL_NAME = 'harness_issue';
export const REACT_TO_MESSAGE_TOOL_NAME = 'react_to_message';
export const LOAD_SKILL_TOOL_NAME = 'load_skill';

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
 * Tools whose handler time does not count against the reply's tool budget.
 *
 * They cost the reply nothing: the product tools hand over what the reply made
 * (a picture, a sticker, a file, a card), `workspace` lets it finish and
 * preview the draft it is about to hand over, `harness_issue` only writes a
 * local row, and `load_skill` reads an in-memory repository spec. None of them
 * spends the budget on looking around, so the reply is never unable to deliver
 * or to report a problem because its clock ran out. The same set is what a
 * post-budget round still offers; the round count there (FREE_TOOL_ROUNDS_MAX)
 * is the bound.
 *
 * `react_to_message` joins for the same reason: it is one tiny Bot API call
 * with no cost, so a reply may still answer "got it" after its clock is gone.
 * It is offered in every chat with client tools, which means `hasFreeTools` is
 * now true there: a reply past its budget gets the free rounds instead of
 * being forced to answer at once (accepted, design 2026-1120).
 */
export const TIME_FREE_TOOL_NAMES: ReadonlySet<string> = new Set([
    ...PRODUCT_TOOL_NAMES,
    WORKSPACE_TOOL_NAME,
    // It only writes one local row, and the Gemini loop may offer it in the
    // last round after every budget is gone. Adding it cannot flip the
    // no-cost/final split: it exists only while `workspace` (also time-free) is
    // offered, so hasFreeTools is already true whenever it is.
    LEAVE_HANDOFF_TOOL_NAME,
    HARNESS_ISSUE_TOOL_NAME,
    LOAD_SKILL_TOOL_NAME,
    REACT_TO_MESSAGE_TOOL_NAME,
]);

export const isTimeFreeToolName = (name: string): boolean => TIME_FREE_TOOL_NAMES.has(name);

/** Built-in names an MCP tool may never take */
export const RESERVED_TOOL_NAMES: readonly string[] = [
    SEND_SMS_TOOL_NAME,
    GENERATE_IMAGE_TOOL_NAME,
    FIND_IMAGE_TOOL_NAME,
    FETCH_IMAGE_TOOL_NAME,
    CROP_IMAGE_TOOL_NAME,
    EXTRACT_FRAMES_TOOL_NAME,
    SEND_IMAGE_TOOL_NAME,
    SEND_STICKER_TOOL_NAME,
    SEND_FILE_TOOL_NAME,
    SEND_WIDGET_TOOL_NAME,
    WORKSPACE_TOOL_NAME,
    LEAVE_HANDOFF_TOOL_NAME,
    HISTORY_TOOL_NAME,
    HARNESS_ISSUE_TOOL_NAME,
    REACT_TO_MESSAGE_TOOL_NAME,
    LOAD_SKILL_TOOL_NAME,
];
