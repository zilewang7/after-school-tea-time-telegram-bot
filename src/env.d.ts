declare global {
    namespace NodeJS {
        interface ProcessEnv {
            BOT_TOKEN: string
            BOT_USER_ID: string
            BOT_USER_NAME: string
            OPENAI_API_KEY: string
            OPENAI_API_URL: string
            SYSTEM_PROMPT?: string
            SYSTEM_PROMPT_FILE?: string
            GOOGLE_CLOUD_LOCATION?: string
            GOOGLE_CLOUD_PROJECT?: string
            GOOGLE_GENAI_USE_VERTEXAI?: string
            GEMINI_API_KEY?: string
            GEMINI_API_URL?: string
            /** Second hub key bound to Vertex-type channels, used for gs:// media */
            GEMINI_LARGE_MEDIA_API_KEY?: string
            /** Origin-side base URL for gs:// media (no CDN 100s cut-off) */
            GEMINI_LARGE_MEDIA_API_URL?: string
            DEFAULT_MODEL?: string
            DEEPSEEK_API_URL?: string
            DEEPSEEK_API_KEY?: string
            GROK_API_KEY?: string
            GROK_API_URL?: string
            MIMO_API_URL?: string
            MIMO_API_KEY?: string
            MCP_SERVERS?: string
            /** Comma-separated chat ids offered send_sms_to_owner and generate_image */
            TOOL_CHAT_IDS?: string
            /** Comma-separated tool names or MCP server keys to switch off */
            DISABLED_TOOLS?: string
            /** '0' turns off search_history / read_history */
            HISTORY_TOOLS?: string
            /** Comma-separated chat ids whose history luoxu archives */
            HISTORY_CHAT_IDS?: string
            /** '0' turns off list_harness_issues / create_harness_issue */
            HARNESS_ISSUES?: string
            /** '1' offers send_widget / get_ui_guide (Phase 0 default off) */
            WIDGET_ENABLE?: string
            /** Comma-separated chat ids offered the widget tools; empty = TOOL_CHAT_IDS */
            WIDGET_CHAT_IDS?: string
            /** '1' additionally allows the model to write full widget HTML */
            WIDGET_ALLOW_HTML?: string
            /** Bot API root for widget calls (default https://api.telegram.org) */
            WIDGET_API_ROOT?: string
            /** '0' skips the startup widget readiness probe */
            WIDGET_READY_CHECK?: string
            /** Chat the owner /widget_probe sends a throwaway widget to */
            WIDGET_PROBE_CHAT_ID?: string
            /** Server limits; defaults 32768 / 4096 */
            WIDGET_MAX_HTML_BYTES?: string
            WIDGET_MAX_GZIP_BYTES?: string
            /** '0' disables the browser login (/web) and its routes */
            WEB_LOGIN?: string
            /** '0' leaves Gemini with its built-in search tools only */
            GEMINI_CLIENT_TOOLS?: string
            /** Telegram user id of the owner send_sms_to_owner reaches */
            OWNER_USER_ID?: string
            /** Owner's name in model-facing text (default 机主) */
            OWNER_DISPLAY_NAME?: string
            /** What the chat calls the owner */
            OWNER_SHORT_NAME?: string
            /** Owner SMS MCP endpoint; empty = no send_sms_to_owner */
            OWNER_SMS_MCP_URL?: string
            /** Bearer token for OWNER_SMS_MCP_URL */
            OWNER_SMS_MCP_TOKEN?: string
            /** '1' lets a TEST_INSTANCE send SMS too */
            OWNER_SMS_ALLOW_TEST?: string
            /** comfy-forward base URL for /pic; replaces PICZIT_ENDPOINT */
            COMFY_FORWARD_URL?: string
            /** How long to keep polling one picture job (default 15min) */
            COMFY_JOB_TIMEOUT_MS?: string
            /** How long to keep polling one video job (default 30min) */
            COMFY_VIDEO_JOB_TIMEOUT_MS?: string
            /** Overrides for the comfy-forward HTTP budgets, in ms */
            COMFY_HEALTH_TIMEOUT_MS?: string
            COMFY_SUBMIT_TIMEOUT_MS?: string
            COMFY_POLL_TIMEOUT_MS?: string
            COMFY_DOWNLOAD_TIMEOUT_MS?: string
            COMFY_VIDEO_DOWNLOAD_TIMEOUT_MS?: string
            /** Grok model that writes /vid storyboards (default grok-4.7) */
            GROK_PROMPT_MODEL?: string
            /** Overrides prompts/h3-video-prompt.md */
            H3_PROMPT_FILE?: string
            /** @deprecated legacy name for COMFY_FORWARD_URL */
            PICZIT_ENDPOINT?: string
            BOT_PROXY?: string
            TGS_CONVERTER_URL?: string
            TG_LOCAL_API_ROOT?: string
            MAX_MEDIA_BYTES?: string
            GCS_BUCKET?: string
            GOOGLE_APPLICATION_CREDENTIALS?: string
            LUOXU_PREVIEW_URL?: string
            /** Sliding batch window for merging a burst of triggers (default 500ms) */
            MENTION_BATCH_WINDOW_MS?: string
            /** Control panel HTTP port; unset = no panel server (set in compose, never in .env) */
            WEBAPP_PORT?: string
            /** Public URL of the panel, for the private-chat web_app button */
            WEBAPP_PUBLIC_URL?: string
            /** BotFather short name of the Mini App, for group Direct Links (default panel) */
            WEBAPP_BOT_SHORT_NAME?: string
            /** Base URL of the widget-render sidecar; empty = rendering off (default http://widget-render:8099) */
            WIDGET_RENDER_URL?: string
            /** '1' lets groups use send_widget through the Mini App link fallback */
            WIDGET_GROUP_FALLBACK?: string
            /** '0' turns off the public share pages and the share API */
            SHARE_ENABLED?: string
            /** '0' turns off the /share and /shareone commands */
            SHARE_COMMAND?: string
            /** '0' turns off the long-thinking link pages and the link mode */
            THINKING_LINK?: string
            /** HMAC secret for signed widget URLs (default: derived from BOT_TOKEN) */
            WEBAPP_SHARE_SECRET?: string
        }
    }
}

export { }