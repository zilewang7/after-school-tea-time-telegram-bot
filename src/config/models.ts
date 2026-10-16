
export interface ModelConfig {
    id: string;
    name: string;
}

export const OPENAI_IMAGE_MODEL = "gpt-image-2.5-sunburst";
export const OPENAI_IMAGE_CHAT_BASE_MODEL = "gpt-6-sol";
/** Gemini image generation: /picbanana, the /model menu entry and generate_image */
export const GEMINI_IMAGE_MODEL = "gemini-nano-banana-2.1";

export const modelConfigs: ModelConfig[] = [
    { id: "gpt-6-luna", name: "gpt-6-luna" },
    { id: "gpt-6-sol", name: "gpt-6-sol" },
    { id: "gpt-6-astra", name: "gpt-6-astra" },
    { id: "claude-sonnet-5", name: "claude-sonnet-5" },
    { id: "claude-opus-5-5", name: "claude-opus-5-5" },
    { id: "gemini-3.8-flash", name: "gemini-3.8-flash" },
    { id: "gemini-4-argon", name: "gemini-4-argon" },
    { id: "deepseek-flash", name: "deepseek-flash" },
    { id: "grok-4.7", name: "grok-4.7" },
    { id: "grok-4.20-multi-agent-0309", name: "grok-4.20-multi-agent" },
    { id: "mimo-v2.6-flash", name: "mimo-v2.6-flash" },
    { id: "mimo-v2.6-pro", name: "mimo-v2.6-pro" },
    { id: GEMINI_IMAGE_MODEL, name: GEMINI_IMAGE_MODEL },
    { id: OPENAI_IMAGE_MODEL, name: OPENAI_IMAGE_MODEL },
];
