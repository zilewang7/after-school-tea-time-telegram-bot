
export interface ModelConfig {
    id: string;
    name: string;
}

export const modelConfigs: ModelConfig[] = [
    { id: "gpt-5.2-chat-latest", name: "gpt-5.2" },
    { id: "o4-mini-high", name: "o4-mini-high" },
    { id: "claude-sonnet-4-5-20250929", name: "claude-sonnet-4.5" },
    { id: "claude-sonnet-4-5-20250929-thinking", name: "claude-sonnet-4.5-thinking" },
    { id: "gemini-3-flash-preview", name: "gemini-3-flash" },
    { id: "gemini-3-pro-preview", name: "gemini-3-pro" },
    { id: "deepseek-chat", name: "deepseek-v3.2" },
    { id: "deepseek-reasoner", name: "deepseek-v3.2-thinking" },
    { id: "grok-4-1-fast-non-reasoning", name: "grok-4.1" },
    { id: "grok-4-1-fast-reasoning", name: "grok-4.1-thinking" },
    { id: "gemini-3-pro-image-preview", name: "gemini-3-pro-image" },
];