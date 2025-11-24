
export interface ModelConfig {
    id: string;
    name: string;
}

export const modelConfigs: ModelConfig[] = [
    { id: "gpt-5-chat-latest", name: "gpt-5" },
    { id: "gpt-5-thinking", name: "gpt-5-thinking" },
    { id: "claude-sonnet-4-5-20250929", name: "claude-sonnet-4.5" },
    { id: "claude-sonnet-4-5-20250929-thinking-64k", name: "claude-sonnet-4.5-thinking" },
    { id: "gemini-2.5-pro", name: "gemini-2.5-pro" },
    { id: "gemini-3-pro-preview", name: "gemini-3-pro" },
    { id: "deepseek-chat", name: "deepseek-v3" },
    { id: "deepseek-reasoner", name: "deepseek-r1" },
    { id: "grok-3", name: "grok-3" },
    { id: "grok-3-mini", name: "grok-3-mini" },
];