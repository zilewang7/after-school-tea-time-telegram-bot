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
        }
    }
}

export { }