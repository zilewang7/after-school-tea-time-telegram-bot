/**
 * Priority PayGo texts and rules shared by the global and the chat settings
 * pages (design §8.2, §8.5). The server decides; these only mirror it for display.
 */

export const GEMINI_PRIORITY_LABEL = 'Priority PayGo';

export const GEMINI_PRIORITY_HELP =
    'Vertex 有优先容量时按优先档服务，价格为标准档的 1.8 倍；没有容量时自动按标准档服务和计费。';

// Which replies the switch reaches at all: "当前生效" alone does not say
export const GEMINI_PRIORITY_APPLIES_HINT = '只对 Vertex 直连的 Gemini 文字模型回复生效，试用用户触发的回复不使用。';

// Same wording as the server's refusal, so the hint and a refused save agree
export const GEMINI_PRIORITY_NOT_ALLOWED_HINT = '全局关闭时，只有工具白名单里的会话可以单独开启';

export const GEMINI_PRIORITY_OWNER_ONLY_HINT = '只有机主可以开关';

// What the global switch means for chats (decision D6)
export const GLOBAL_GEMINI_PRIORITY_SCOPE_HINT =
    '开：没有单独设置的聊天都按开处理，聊天可以单独关闭。关：只有工具白名单里的聊天可以单独开启。';

export const onOffLabel = (on: boolean): string => (on ? '开' : '关');

/** The switch as GET /api/chats/:id reports it for one chat */
export interface ChatGeminiPriorityState {
    // Whether the chat's Gemini replies ask for the priority tier now
    effective: boolean;
    // The global switch
    globalOn: boolean;
    // "On" can take effect here: the global switch is on, or the chat is in TOOL_CHAT_IDS
    canEnable: boolean;
}

/** One chip of the chat page's choice (a ChoiceChips option) */
export interface GeminiPriorityOption {
    // null = follow the global switch
    value: boolean | null;
    label: string;
    disabled: boolean;
}

/**
 * The chat page's three choices. "On" cannot be newly chosen where it would not
 * take effect; a saved "on" can still be picked back after moving away from it.
 */
export const chatGeminiPriorityOptionsOf = (
    globalOn: boolean,
    canEnable: boolean,
    savedChoice: boolean | null
): GeminiPriorityOption[] => [
    { value: null, label: `跟随全局（当前 ${onOffLabel(globalOn)}）`, disabled: false },
    { value: true, label: '开', disabled: !canEnable && savedChoice !== true },
    { value: false, label: '关', disabled: false },
];

/**
 * The chat's effective value: its own choice, or the global switch when it has
 * none; a stored "on" only takes effect where it can be enabled.
 */
export const effectiveGeminiPriorityOf = (
    chatChoice: boolean | null,
    globalOn: boolean,
    canEnable: boolean
): boolean => (chatChoice === null ? globalOn : chatChoice && canEnable);
