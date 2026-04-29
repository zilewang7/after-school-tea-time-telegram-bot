
export interface ModelConfig {
    id: string;
    name: string;
}

export const modelConfigs: ModelConfig[] = [
    { id: "gpt-5.2", name: "gpt-5.2" },
    { id: "gpt-5.4", name: "gpt-5.4" },
    { id: "claude-sonnet-4-5-20250929", name: "claude-sonnet-4.5" },
    { id: "claude-sonnet-4-5-20250929-thinking", name: "claude-sonnet-4.5-thinking" },
    { id: "gemini-3-flash-preview", name: "gemini-3-flash" },
    { id: "gemini-3.1-pro-preview", name: "gemini-3.1-pro" },
    { id: "deepseek-chat", name: "deepseek-v4-flash" },
    { id: "deepseek-reasoner", name: "deepseek-v4-pro" },
    { id: "grok-4.20-0309-reasoning", name: "grok-4.20" },
    { id: "grok-4.20-multi-agent-0309", name: "grok-4.20-multi-agent" },
    { id: "mimo-v2.5", name: "mimo-v2.5" },
    { id: "mimo-v2.5-pro", name: "mimo-v2.5-pro" },
    { id: "gemini-3-pro-image-preview", name: "gemini-3-pro-image" },
    { id: "gpt-image-2-dev", name: "gpt-image-2" },
];
