
export interface ModelConfig {
    id: string;
    name: string;
}

export const modelConfigs: ModelConfig[] = [
    { id: "gpt-5.4-mini", name: "gpt-5.4-mini" },
    { id: "gpt-5.5", name: "gpt-5.5" },
    { id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" },
    { id: "claude-opus-4-8", name: "claude-opus-4-8" },
    { id: "gemini-3.5-flash", name: "gemini-3.5-flash" },
    { id: "gemini-3.1-pro-preview", name: "gemini-3.1-pro" },
    { id: "deepseek-v4-flash", name: "deepseek-v4-flash" },
    { id: "deepseek-v4-pro", name: "deepseek-v4-pro" },
    { id: "grok-4.3", name: "grok-4.3" },
    { id: "grok-4.20-multi-agent-0309", name: "grok-4.20-multi-agent" },
    { id: "mimo-v2.5", name: "mimo-v2.5" },
    { id: "mimo-v2.5-pro", name: "mimo-v2.5-pro" },
    { id: "gemini-3-pro-image", name: "gemini-3-pro-image" },
    { id: "gpt-image-2-dev", name: "gpt-image-2" },
];
