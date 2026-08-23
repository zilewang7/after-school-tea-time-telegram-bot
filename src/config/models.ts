
export interface ModelConfig {
    id: string;
    name: string;
}

export const modelConfigs: ModelConfig[] = [
    { id: "gpt-5.6-luna", name: "gpt-5.6-luna" },
    { id: "gpt-5.6-sol", name: "gpt-5.6-sol" },
    { id: "claude-sonnet-5", name: "claude-sonnet-5" },
    { id: "claude-opus-5", name: "claude-opus-5" },
    { id: "gemini-3.7-flash", name: "gemini-3.7-flash" },
    { id: "gemini-3.1-pro-preview", name: "gemini-3.1-pro" },
    { id: "deepseek-v4-flash-vision-exp", name: "deepseek-v4-flash-vision-exp" },
    { id: "deepseek-v4-pro", name: "deepseek-v4-pro" },
    { id: "grok4.6", name: "grok4.6" },
    { id: "grok-4.20-multi-agent-0309", name: "grok-4.20-multi-agent" },
    { id: "mimo-v2.5", name: "mimo-v2.5" },
    { id: "mimo-v2.5-pro", name: "mimo-v2.5-pro" },
    { id: "gemini-3-pro-image", name: "gemini-3-pro-image" },
    { id: "gpt-image-2-dev", name: "gpt-image-2" },
];
