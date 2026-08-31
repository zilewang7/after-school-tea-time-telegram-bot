/**
 * The operator-editable "preference" layer of the system prompt: persona,
 * tone, reply-language rules. Everything protocol-ish (message format,
 * capabilities, …) is built-in — see sections.ts.
 */
import { readFileSync } from 'node:fs';

/**
 * Env vars a prompt may reference as `{{VAR}}`. Only the bot's own identity for
 * now — the same prompt file is shared by the production and test instances,
 * which are different bots, so a hardcoded handle makes the test bot introduce
 * itself as the production one.
 */
const PROMPT_VARIABLES = ['BOT_USER_NAME', 'BOT_NAME'] as const;

/** Substitute `{{VAR}}` for the allowlisted env vars; unknown ones stay put */
const applyPromptVariables = (prompt: string): string => {
    let result = prompt;
    for (const variable of PROMPT_VARIABLES) {
        const placeholder = `{{${variable}}}`;
        if (!result.includes(placeholder)) continue;
        const value = process.env[variable];
        if (!value) {
            console.warn(`[system-prompt] ${placeholder} is used but ${variable} is not set`);
            continue;
        }
        result = result.replaceAll(placeholder, value);
    }
    return result;
};

/**
 * Preference source: SYSTEM_PROMPT_FILE (multi-line markdown file, read once
 * at first use) preferred; SYSTEM_PROMPT env var as fallback for setups where
 * mounting a file is inconvenient. Either may reference the bot's identity as
 * `{{BOT_USER_NAME}}` / `{{BOT_NAME}}`.
 */
let cachedPreferencePrompt: string | undefined;

export const getPreferencePrompt = (): string => {
    if (cachedPreferencePrompt !== undefined) return cachedPreferencePrompt;

    const promptFile = process.env.SYSTEM_PROMPT_FILE;
    if (promptFile) {
        try {
            cachedPreferencePrompt = applyPromptVariables(readFileSync(promptFile, 'utf-8').trim());
            return cachedPreferencePrompt;
        } catch (error) {
            console.error(`[system-prompt] failed to read ${promptFile}, falling back to SYSTEM_PROMPT env:`, error);
        }
    }

    cachedPreferencePrompt = applyPromptVariables(process.env.SYSTEM_PROMPT || '');
    return cachedPreferencePrompt;
};
