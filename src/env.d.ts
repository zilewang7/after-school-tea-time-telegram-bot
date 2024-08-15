declare global {
    namespace NodeJS {
        interface ProcessEnv {
            BOT_TOKEN: string
            BOT_USER_ID: string
            BOT_USER_NAME: string
            OPENAI_API_KEY: string
            OPENAI_API_URL: string
            SYSTEM_PROMPT: string
            GEMINI_API_KEY?: string
            DEFAULT_MODEL?: string
        }
    }
}

export { }