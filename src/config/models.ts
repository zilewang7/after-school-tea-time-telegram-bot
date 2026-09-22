
export interface ModelConfig {
    id: string;
    name: string;
}

export const OPENAI_IMAGE_MODEL = "gpt-image-2.5-sunburst";
export const OPENAI_IMAGE_CHAT_BASE_MODEL = "gpt-5.6-sol";

export const modelConfigs: ModelConfig[] = [
    { id: "gpt-5.6-luna", name: "gpt-5.6-luna" },
    { id: "gpt-5.6-sol", name: "gpt-5.6-sol" },
    { id: "gpt-6-astra", name: "gpt-6-astra" },
    { id: "claude-sonnet-5", name: "claude-sonnet-5" },
    { id: "claude-opus-5", name: "claude-opus-5" },
    { id: "gemini-3.8-flash", name: "gemini-3.8-flash" },
    { id: "gemini-3.1-pro-preview", name: "gemini-3.1-pro" },
    { id: "deepseek-flash", name: "deepseek-flash" },
    { id: "grok4.6", name: "grok4.6" },
    { id: "grok-4.20-multi-agent-0309", name: "grok-4.20-multi-agent" },
    { id: "mimo-v2.6-flash", name: "mimo-v2.6-flash" },
    { id: "mimo-v2.6-pro", name: "mimo-v2.6-pro" },
    { id: "gemini-3-pro-image", name: "gemini-3-pro-image" },
    { id: OPENAI_IMAGE_MODEL, name: OPENAI_IMAGE_MODEL },
];
