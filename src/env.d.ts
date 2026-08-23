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
            DEFAULT_MODEL?: string
            DEEPSEEK_API_URL?: string
            DEEPSEEK_API_KEY?: string
            GROK_API_KEY?: string
            GROK_API_URL?: string
            MIMO_API_URL?: string
            MIMO_API_KEY?: string
            MCP_SERVERS?: string
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
            /** Grok model that writes /vid storyboards (default grok4.6) */
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
        }
    }
}

export { }