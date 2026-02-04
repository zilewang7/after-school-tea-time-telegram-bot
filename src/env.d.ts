declare global {
    namespace NodeJS {
        interface ProcessEnv {
            BOT_TOKEN: string
            BOT_USER_ID: string
            BOT_USER_NAME: string
            OPENAI_API_KEY: string
            OPENAI_API_URL: string
            SYSTEM_PROMPT: string
            GOOGLE_CLOUD_LOCATION?: string
            GOOGLE_CLOUD_PROJECT?: string
            GOOGLE_GENAI_USE_VERTEXAI?: string
            GEMINI_API_KEY?: string
            DEFAULT_MODEL?: string
            DEEPSEEK_API_URL?: string
            DEEPSEEK_API_KEY?: string
            GROK_API_KEY?: string
            GROK_API_URL?: string
            PICZIT_ENDPOINT?: string
            BOT_PROXY?: string
        }
    }
}

export { }