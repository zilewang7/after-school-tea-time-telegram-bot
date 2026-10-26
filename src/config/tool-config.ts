/**
 * Client tool settings, read from the env once (on first use).
 *
 * - TOOL_CHAT_IDS: chats offered the tools with side effects (owner SMS, image
 *   generation), comma-separated
 * - DISABLED_TOOLS: tool names (MCP tools by their original name) or MCP server
 *   keys switched off, comma-separated
 * - GEMINI_CLIENT_TOOLS=0: Gemini keeps its built-in search tools only
 * - IMAGE_TOOLS=0: no search_images / fetch_image / send_image
 * - IMAGE_SEARCH_URL: the SearXNG base URL (default http://searxng:8080)
 * - IMAGE_SEARCH_ENGINES: comma-separated SearXNG engines; empty = its defaults
 * - IMAGE_SEARCH_SAFESEARCH: 0 / 1 / 2, fixed for the model (default 1)
 * - IMAGE_SEARCH_GROUNDING=0: image generation does not declare imageSearch
 * - IMAGE_REVERSE_SEARCH=0: no search_by_image (Yandex reverse image search)
 * - OWNER_SMS_MCP_URL: the owner SMS endpoint; empty = no SMS tool
 * - OWNER_SMS_ALLOW_TEST=1: the test instance may send SMS too (off by default:
 *   it inherits the production env)
 * - OWNER_USER_ID / OWNER_DISPLAY_NAME / OWNER_SHORT_NAME: who send_sms_to_owner
 *   reaches, the short name being what the chat calls them. They live in the
 *   env, never in the code: the repository is public.
 */
import { parseChatIdList } from './chat-id-list.js';

export interface OwnerIdentity {
    /** Telegram user id; null when not configured */
    readonly userId: string | null;
    readonly displayName: string;
    /** What the chat calls the owner; null when not configured */
    readonly shortName: string | null;
}

export interface ToolConfig {
    readonly toolChatIds: ReadonlySet<number>;
    readonly disabledTools: ReadonlySet<string>;
    readonly geminiClientTools: boolean;
    /** search_images / send_image / fetch_image are on */
    readonly imageTools: boolean;
    readonly imageSearchUrl: string;
    /** Comma-joined SearXNG engines; empty = the instance's own default */
    readonly imageSearchEngines: string;
    readonly imageSearchSafesearch: 0 | 1 | 2;
    /** Image generation declares searchTypes.imageSearch (supported models only) */
    readonly imageSearchGrounding: boolean;
    /** search_by_image is offered */
    readonly imageReverseSearch: boolean;
    /** Empty when not configured */
    readonly ownerSmsUrl: string;
    readonly ownerSmsAllowTest: boolean;
    readonly owner: OwnerIdentity;
}

/** Stands in for OWNER_DISPLAY_NAME when it is not set */
const DEFAULT_OWNER_NAME = '机主';

const splitList = (raw: string | undefined): string[] =>
    (raw ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

/** A trimmed env value; null when unset or blank */
const optionalValue = (raw: string | undefined): string | null => raw?.trim() || null;

const DEFAULT_IMAGE_SEARCH_URL = 'http://searxng:8080';

/** 0 / 1 / 2; anything else keeps the moderate default */
const parseSafesearch = (raw: string | undefined): 0 | 1 | 2 => {
    const parsed = Number.parseInt((raw ?? '').trim(), 10);
    return parsed === 0 || parsed === 2 ? parsed : 1;
};

const readOwner = (env: NodeJS.ProcessEnv): OwnerIdentity => {
    const displayName = optionalValue(env.OWNER_DISPLAY_NAME) ?? DEFAULT_OWNER_NAME;
    const shortName = optionalValue(env.OWNER_SHORT_NAME);
    return {
        userId: optionalValue(env.OWNER_USER_ID),
        displayName,
        // A short name equal to the display name adds nothing
        shortName: shortName === displayName ? null : shortName,
    };
};

/** The settings in `env`; exported for tests, the app goes through getToolConfig */
export const readToolConfig = (env: NodeJS.ProcessEnv = process.env): ToolConfig => ({
    toolChatIds: new Set(parseChatIdList(env.TOOL_CHAT_IDS)),
    disabledTools: new Set(splitList(env.DISABLED_TOOLS)),
    geminiClientTools: env.GEMINI_CLIENT_TOOLS !== '0',
    imageTools: env.IMAGE_TOOLS !== '0',
    imageSearchUrl: optionalValue(env.IMAGE_SEARCH_URL) ?? DEFAULT_IMAGE_SEARCH_URL,
    imageSearchEngines: splitList(env.IMAGE_SEARCH_ENGINES).join(','),
    imageSearchSafesearch: parseSafesearch(env.IMAGE_SEARCH_SAFESEARCH),
    imageSearchGrounding: env.IMAGE_SEARCH_GROUNDING !== '0',
    imageReverseSearch: env.IMAGE_REVERSE_SEARCH !== '0',
    ownerSmsUrl: env.OWNER_SMS_MCP_URL?.trim() ?? '',
    ownerSmsAllowTest: env.OWNER_SMS_ALLOW_TEST === '1',
    owner: readOwner(env),
});

let cachedToolConfig: ToolConfig | undefined;

export const getToolConfig = (): ToolConfig => {
    cachedToolConfig ??= readToolConfig();
    return cachedToolConfig;
};

export interface OwnerLabelOptions {
    /** How the id is introduced, e.g. `Telegram id` */
    readonly idLabel: string;
    /** Lead with the short name, the display name moving into the brackets */
    readonly withShortName: boolean;
}

/**
 * The owner as model-facing text names them: `阿主（阿主 某某，Telegram id 1）`
 * with the short name, `阿主 某某（id 1）` without; unset parts drop out.
 */
export const formatOwnerLabel = (owner: OwnerIdentity, options: OwnerLabelOptions): string => {
    const leadName = options.withShortName && owner.shortName !== null ? owner.shortName : owner.displayName;
    const details = [
        leadName === owner.displayName ? null : owner.displayName,
        owner.userId === null ? null : `${options.idLabel} ${owner.userId}`,
    ].filter((detail): detail is string => detail !== null);
    return details.length > 0 ? `${leadName}（${details.join('，')}）` : leadName;
};
