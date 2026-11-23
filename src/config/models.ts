
export interface ModelConfig {
    id: string;
    name: string;
}

/** GPT image generation: /picgpt and the gpt half of generate_image */
export const OPENAI_IMAGE_MODEL = "gpt-image-2.5-dev";
/** Gemini image generation: /picbanana and generate_image */
export const GEMINI_IMAGE_MODEL = "gemini-nano-banana-2.1";
/** xAI image generation: /picgrok (a one-shot images API call, not a chat platform) */
export const GROK_IMAGE_MODEL = "grok-imagine-image-quality";

/**
 * Image ids the relay bills per call rather than per token: a generation is
 * recorded as a count only (no token usage), so the cost estimate prices it by
 * the model's perImageUsd instead of mixing token prices into a call fee.
 */
export const CALL_BILLED_IMAGE_MODELS: ReadonlySet<string> = new Set([OPENAI_IMAGE_MODEL]);

/**
 * `name` is the menu button text and the label the catalog stores, so it uses
 * the display name the sources publish (models.dev, ephone), not the id: the
 * price watcher adds new models with that same style, and a menu mixing both
 * reads as two different kinds of entry.
 */
export const modelConfigs: ModelConfig[] = [
    { id: "gpt-6-luna", name: "GPT-6 Luna" },
    { id: "gpt-6-sol", name: "GPT-6 Sol" },
    { id: "gpt-6-astra", name: "GPT-6 Astra" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
    { id: "gemini-4-neon", name: "Gemini 4 Neon" },
    { id: "gemini-4-carbon", name: "Gemini 4 Carbon" },
    { id: "deepseek-flash", name: "DeepSeek V4.1 Flash" },
    { id: "grok-4.7", name: "Grok 4.7" },
    { id: "grok-4.20-multi-agent-0309", name: "Grok 4.20 Multi-Agent" },
    { id: "mimo-v2.6-flash", name: "MiMo-V2.6-Flash" },
    { id: "mimo-v2.6-pro", name: "MiMo-V2.6-Pro" },
];
