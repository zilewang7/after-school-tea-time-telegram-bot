/**
 * Shared types and validation constants for the repository-backed skill system.
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

export const SKILL_MAX_DESCRIPTION_CHARS = 1024;
export const SKILL_MAX_BODY_CHARS = 24_000;
export const SKILL_MAX_BODY_LINES = 500;
export const SKILL_MAX_COUNT = 20;

/** Supported `metadata.bot.required-flags` names; unknown flags fail closed */
export const WIDGET_ALLOW_HTML_FLAG = 'widget-allow-html';

export const KNOWN_SKILL_FLAGS: ReadonlySet<string> = new Set([WIDGET_ALLOW_HTML_FLAG]);

export type SkillScope = 'all' | 'group' | 'private';
export type SkillChatScope = 'group' | 'private';

export interface SkillEntry {
    readonly name: string;
    readonly description: string;
    readonly body: string;
    readonly version: string;
    readonly requiredTools: readonly string[];
    readonly anyTools: readonly string[];
    readonly requiredFlags: readonly string[];
    readonly scope: SkillScope;
    readonly ownerOnly: boolean;
    readonly source: 'repo';
}

export interface SkillFilterInput {
    readonly skills: readonly SkillEntry[];
    readonly declaredToolNames: ReadonlySet<string>;
    readonly activeFlags: ReadonlySet<string>;
    readonly scope: SkillChatScope;
    readonly isOwner: boolean;
}
