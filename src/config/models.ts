
export interface ModelConfig {
    id: string;
    name: string;
}

export const modelConfigs: ModelConfig[] = [
    { id: "gpt-4o-2024-11-20", name: "gpt-4o-2024-11-20" },
    { id: "o1-preview-2024-09-12", name: "o1-preview-2024-09-12" },
    { id: "gemini-2.0-flash-exp", name: "gemini-2.0-flash-exp" },
    { id: "gemini-2.0-flash-thinking-exp", name: "gemini-2.0-flash-thinking-exp" },
    { id: "claude-3-5-sonnet-20241022", name: "claude-3-5-sonnet-20241022" },
    { id: "claude-3-5-sonnet-20240620", name: "claude-3-5-sonnet-20240620" },
    { id: "deepseek-chat", name: "deepseek-v3" },
    { id: "deepseek-reasoner", name: "deepseek-r1" },
];