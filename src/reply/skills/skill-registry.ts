/**
 * Repository skill registry: lazy loading, strict load-time validation,
 * and three-key + scope + owner availability filtering.
 *
 * Bad skills are logged with console.warn and skipped so a single malformed
 * file never crashes the bot process.
 */
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { C0_CONTROL_CHARS, parseSkillFrontmatter } from './skill-frontmatter.js';
import {
    KNOWN_SKILL_FLAGS,
    SKILL_MAX_BODY_CHARS,
    SKILL_MAX_BODY_LINES,
    SKILL_MAX_COUNT,
    SKILL_MAX_DESCRIPTION_CHARS,
    SKILL_NAME_PATTERN,
    TOOL_NAME_PATTERN,
    type SkillEntry,
    type SkillFilterInput,
    type SkillScope,
} from './skill-types.js';

export type { SkillChatScope, SkillEntry, SkillFilterInput, SkillScope } from './skill-types.js';
export {
    KNOWN_SKILL_FLAGS,
    SKILL_MAX_BODY_CHARS,
    SKILL_MAX_BODY_LINES,
    SKILL_MAX_COUNT,
    SKILL_MAX_DESCRIPTION_CHARS,
    SKILL_NAME_PATTERN,
    TOOL_NAME_PATTERN,
    WIDGET_ALLOW_HTML_FLAG,
} from './skill-types.js';

const FORBIDDEN_WIRE_MARKERS = ['[工具轮次]', '[时间]', '<<EOF'] as const;
const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

const charsOf = (text: string): number => Array.from(text).length;

/**
 * Strip inline backtick code spans (including multi-backtick spans like `` `foo` ``)
 * on one non-fenced Markdown line so backtick-quoted marker mentions are allowed.
 */
const stripInlineCodeSpans = (line: string): string => {
    let result = '';
    let index = 0;
    while (index < line.length) {
        if (line[index] !== '`') {
            result += line[index];
            index += 1;
            continue;
        }
        let ticks = 0;
        while (index + ticks < line.length && line[index + ticks] === '`') ticks += 1;
        const delimiter = '`'.repeat(ticks);
        const closeIndex = line.indexOf(delimiter, index + ticks);
        if (closeIndex === -1) {
            result += delimiter;
            index += ticks;
            continue;
        }
        index = closeIndex + ticks;
    }
    return result;
};

/**
 * Reject standalone bare lines or un-backticked wire markers (`[工具轮次]`,
 * `[时间]`, `<<EOF`) so a skill body cannot mimic `tool-round.ts` budget tails
 * or context message delimiters, while preserving fenced code blocks and
 * inline backticked references.
 */
const findForbiddenWireMarker = (body: string): string | null => {
    const lines = body.split('\n');
    let lineIndex = 0;

    while (lineIndex < lines.length) {
        const line = lines[lineIndex] ?? '';
        const openMatch = FENCE_OPEN_PATTERN.exec(line);
        if (openMatch !== null) {
            const fence = openMatch[1] ?? '```';
            const fenceChar = fence[0] ?? '`';
            const minLength = fence.length;
            const closePattern = new RegExp(`^ {0,3}${fenceChar}{${minLength},}[ \\t]*$`);
            let closeIndex = -1;
            for (let scan = lineIndex + 1; scan < lines.length; scan += 1) {
                if (closePattern.test(lines[scan] ?? '')) {
                    closeIndex = scan;
                    break;
                }
            }
            if (closeIndex !== -1) {
                lineIndex = closeIndex + 1;
                continue;
            }
        }

        const outsideInlineCode = stripInlineCodeSpans(line);
        for (const marker of FORBIDDEN_WIRE_MARKERS) {
            if (outsideInlineCode.includes(marker)) {
                return marker;
            }
        }
        lineIndex += 1;
    }

    return null;
};

type ListParseResult =
    | { readonly ok: true; readonly values: readonly string[] }
    | { readonly ok: false; readonly error: string };

const parseCommaSeparatedNames = (
    raw: string | undefined,
    fieldName: string,
    pattern: RegExp
): ListParseResult => {
    if (raw === undefined || raw.trim() === '') return { ok: true, values: [] };
    const parts = raw.split(',');
    const values: string[] = [];
    const seen = new Set<string>();
    for (const part of parts) {
        const item = part.trim();
        if (item === '') {
            return { ok: false, error: `${fieldName} 包含空项` };
        }
        if (!pattern.test(item)) {
            return { ok: false, error: `${fieldName} 包含非法名称 "${item}"` };
        }
        if (!seen.has(item)) {
            seen.add(item);
            values.push(item);
        }
    }
    return { ok: true, values };
};

const parseScope = (raw: string | undefined): SkillScope | null => {
    if (raw === undefined || raw.trim() === '') return 'all';
    const trimmed = raw.trim();
    if (trimmed === 'all' || trimmed === 'group' || trimmed === 'private') return trimmed;
    return null;
};

const parseOwnerOnly = (raw: string | undefined): boolean | null => {
    if (raw === undefined || raw.trim() === '') return false;
    const trimmed = raw.trim();
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    return null;
};

export type SkillLoadResult =
    | { readonly ok: true; readonly entry: SkillEntry }
    | { readonly ok: false; readonly error: string };

/** Parse and validate one skill's SKILL.md content against its directory name */
export const parseAndValidateSkill = (dirName: string, rawContent: string): SkillLoadResult => {
    const parsed = parseSkillFrontmatter(rawContent);
    if (!parsed.ok) return parsed;

    const { fields, metadata, body } = parsed.value;
    const name = (fields['name'] ?? '').trim();
    if (!SKILL_NAME_PATTERN.test(name)) {
        return { ok: false, error: `name "${name}" 不符合 ^[a-z0-9][a-z0-9-]{0,63}$` };
    }
    if (name !== dirName) {
        return { ok: false, error: `name "${name}" 与目录名 "${dirName}" 不一致` };
    }

    const description = (fields['description'] ?? '').trim();
    const descChars = charsOf(description);
    if (descChars < 1 || descChars > SKILL_MAX_DESCRIPTION_CHARS) {
        return {
            ok: false,
            error: `description 长度必须在 1–${SKILL_MAX_DESCRIPTION_CHARS} 字符之间（当前 ${descChars}）`,
        };
    }

    if (body.trim() === '') {
        return { ok: false, error: '技能正文不能为空' };
    }
    if (C0_CONTROL_CHARS.test(body)) {
        return { ok: false, error: '技能正文包含不允许的 C0 控制字符' };
    }
    const bodyChars = charsOf(body);
    if (bodyChars > SKILL_MAX_BODY_CHARS) {
        return {
            ok: false,
            error: `技能正文超过 ${SKILL_MAX_BODY_CHARS} 字符上限（当前 ${bodyChars}）`,
        };
    }
    const bodyLines = body.split('\n').length;
    if (bodyLines > SKILL_MAX_BODY_LINES) {
        return {
            ok: false,
            error: `技能正文超过 ${SKILL_MAX_BODY_LINES} 行上限（当前 ${bodyLines}）`,
        };
    }

    const forbiddenMarker = findForbiddenWireMarker(body);
    if (forbiddenMarker !== null) {
        return {
            ok: false,
            error: `技能正文包含未用反引号包裹的协议标记 ${forbiddenMarker}`,
        };
    }

    const requiredTools = parseCommaSeparatedNames(
        metadata['bot.required-tools'],
        'bot.required-tools',
        TOOL_NAME_PATTERN
    );
    if (!requiredTools.ok) return requiredTools;

    const anyTools = parseCommaSeparatedNames(
        metadata['bot.any-tools'],
        'bot.any-tools',
        TOOL_NAME_PATTERN
    );
    if (!anyTools.ok) return anyTools;

    const requiredFlags = parseCommaSeparatedNames(
        metadata['bot.required-flags'],
        'bot.required-flags',
        SKILL_NAME_PATTERN
    );
    if (!requiredFlags.ok) return requiredFlags;

    const scope = parseScope(metadata['bot.scope']);
    if (scope === null) {
        return { ok: false, error: `bot.scope "${metadata['bot.scope']}" 无效，必须是 all/group/private` };
    }

    const ownerOnly = parseOwnerOnly(metadata['bot.owner-only']);
    if (ownerOnly === null) {
        return { ok: false, error: `bot.owner-only "${metadata['bot.owner-only']}" 无效，必须是 true/false` };
    }

    const rawVersion = metadata['bot.version'];
    const version = rawVersion === undefined || rawVersion.trim() === '' ? '1' : rawVersion.trim();

    return {
        ok: true,
        entry: {
            name,
            description,
            body,
            version,
            requiredTools: requiredTools.values,
            anyTools: anyTools.values,
            requiredFlags: requiredFlags.values,
            scope,
            ownerOnly,
            source: 'repo',
        },
    };
};

const isDirectoryEntry = (skillsDir: string, name: string, isDir: boolean, isSymlink: boolean): boolean => {
    if (isDir) return true;
    if (!isSymlink) return false;
    try {
        return statSync(join(skillsDir, name)).isDirectory();
    } catch {
        return false;
    }
};

/**
 * Load all valid skills from a directory without touching the process cache.
 * Malformed entries are warned and skipped; valid entries beyond SKILL_MAX_COUNT
 * are truncated in sorted directory-name order.
 */
export const loadSkillsFromDirectory = (skillsDir: string): readonly SkillEntry[] => {
    let dirEntries: readonly Dirent[];
    try {
        dirEntries = readdirSync(skillsDir, { withFileTypes: true, encoding: 'utf8' });
    } catch (error) {
        const code =
            error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (code !== 'ENOENT') {
            console.warn(`[skills] failed to read skills directory ${skillsDir}:`, error);
        }
        return [];
    }

    const dirNames = dirEntries
        .filter((item) => isDirectoryEntry(skillsDir, item.name, item.isDirectory(), item.isSymbolicLink()))
        .map((item) => item.name)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

    const loaded: SkillEntry[] = [];
    for (const dirName of dirNames) {
        const filePath = join(skillsDir, dirName, 'SKILL.md');
        let raw: string;
        try {
            raw = readFileSync(filePath, 'utf8');
        } catch (error) {
            console.warn(`[skills] skipping "${dirName}": failed to read ${filePath}:`, error);
            continue;
        }

        const result = parseAndValidateSkill(dirName, raw);
        if (!result.ok) {
            console.warn(`[skills] skipping invalid skill "${dirName}": ${result.error}`);
            continue;
        }

        if (loaded.length >= SKILL_MAX_COUNT) {
            console.warn(
                `[skills] reached max skill count (${SKILL_MAX_COUNT}); truncating "${dirName}" and later entries`
            );
            break;
        }
        loaded.push(result.entry);
    }

    return loaded;
};

interface CachedRegistry {
    readonly dir: string;
    readonly entries: readonly SkillEntry[];
}

let cachedRegistry: CachedRegistry | null = null;

export const resolveSkillsDir = (overrideDir?: string): string => {
    if (overrideDir !== undefined && overrideDir.trim() !== '') return overrideDir.trim();
    const envDir = process.env.SKILLS_DIR?.trim();
    return envDir !== undefined && envDir !== '' ? envDir : join(process.cwd(), 'skills');
};

/** Lazy-loaded process-wide skill registry, re-loading automatically when the directory changes */
export const getSkillRegistry = (skillsDir?: string): readonly SkillEntry[] => {
    const resolvedDir = resolveSkillsDir(skillsDir);
    if (cachedRegistry !== null && cachedRegistry.dir === resolvedDir) {
        return cachedRegistry.entries;
    }
    const entries = loadSkillsFromDirectory(resolvedDir);
    cachedRegistry = { dir: resolvedDir, entries };
    return entries;
};

/** Clear the cached skill registry (for tests that mutate files in place) */
export const resetSkillRegistryCache = (): void => {
    cachedRegistry = null;
};

/**
 * Filter loaded skills by declared tools, active server feature flags,
 * chat scope (`group` vs `private`), and `ownerOnly` visibility.
 */
export const filterAvailableSkills = (input: SkillFilterInput): readonly SkillEntry[] =>
    input.skills.filter((entry) => {
        if (entry.ownerOnly && !input.isOwner) return false;
        if (entry.scope !== 'all' && entry.scope !== input.scope) return false;

        const toolMatch =
            entry.requiredTools.every((name) => input.declaredToolNames.has(name)) &&
            (entry.anyTools.length === 0 ||
                entry.anyTools.some((name) => input.declaredToolNames.has(name))) &&
            entry.requiredFlags.every(
                (flag) => KNOWN_SKILL_FLAGS.has(flag) && input.activeFlags.has(flag)
            );
        return toolMatch;
    });
