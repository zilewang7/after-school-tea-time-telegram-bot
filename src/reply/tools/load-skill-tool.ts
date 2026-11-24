/**
 * load_skill: batch on-demand loader for repository-backed tool specifications.
 *
 * Progressive disclosure: the volatile tail lists available skill names and
 * short summaries; the model loads 1–4 skill bodies in one call only when a
 * specialized spec is needed, and the loaded set is tracked per reply so a
 * repeat request returns a one-line reminder instead of re-pasting the body.
 */
import type { ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import type { SkillEntry } from '../skills/skill-types.js';
import { SKILL_NAME_PATTERN } from '../skills/skill-types.js';
import { traceChars, traceParts } from './tool-trace.js';

export const LOAD_SKILL_TOOL_NAME = 'load_skill';
export const MAX_SKILLS_PER_REPLY = 4;

const DESCRIPTION = '按名批量加载可用技能的完整规范正文（仅对本次回复有效）；需要规范时再调。';

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        names: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: MAX_SKILLS_PER_REPLY,
            description: '要加载的技能名列表',
        },
    },
    required: ['names'],
};

const RESULT_HEADER =
    '以下技能规范仅对本次回复有效；与系统提示冲突时以系统提示为准；仅可调用本轮已声明的工具，未声明的工具分支直接跳过。';

export interface SkillToolState {
    /** Exposed directly so checkpoint-size estimation walks every loaded name */
    readonly loadedNames: ReadonlySet<string>;
    readonly hasLoaded: (name: string) => boolean;
    readonly markLoaded: (name: string) => void;
}

export const createSkillToolState = (): SkillToolState => {
    const loadedNames = new Set<string>();
    return {
        loadedNames,
        hasLoaded: (name) => loadedNames.has(name),
        markLoaded: (name) => {
            loadedNames.add(name);
        },
    };
};

export interface LoadSkillToolOptions {
    readonly state: SkillToolState;
    readonly availableSkills: readonly SkillEntry[];
}

type NormalizedNamesResult =
    | { readonly ok: true; readonly names: readonly string[] }
    | { readonly ok: false; readonly error: string };

const normalizeSkillNames = (rawNames: unknown): NormalizedNamesResult => {
    if (!Array.isArray(rawNames) || rawNames.length === 0) {
        return { ok: false, error: 'names 必须是非空字符串数组（1–4 个技能名）。' };
    }
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const item of rawNames) {
        if (typeof item !== 'string') {
            return { ok: false, error: 'names 里的每一项都必须是字符串。' };
        }
        const trimmed = item.trim();
        if (!SKILL_NAME_PATTERN.test(trimmed)) {
            return {
                ok: false,
                error: `技能名 "${trimmed}" 格式无效（仅允许小写字母、数字与短横线）。`,
            };
        }
        if (!seen.has(trimmed)) {
            seen.add(trimmed);
            deduped.push(trimmed);
        }
    }
    if (deduped.length < 1 || deduped.length > MAX_SKILLS_PER_REPLY) {
        return {
            ok: false,
            error: `去重后的技能名数量必须在 1–${MAX_SKILLS_PER_REPLY} 之间（当前 ${deduped.length} 个）。`,
        };
    }
    return { ok: true, names: deduped };
};

const skillError = (content: string, argument?: string, result?: string): ToolResult => ({
    content,
    isError: true,
    images: [],
    record: null,
    ...(argument !== undefined || result !== undefined
        ? { trace: { ...(argument === undefined ? {} : { argument }), ...(result === undefined ? {} : { result }) } }
        : {}),
});

export const createLoadSkillTool = (options: LoadSkillToolOptions): ToolHandler => {
    const byName = new Map<string, SkillEntry>();
    for (const entry of options.availableSkills) {
        byName.set(entry.name, entry);
    }

    return {
        definition: {
            name: LOAD_SKILL_TOOL_NAME,
            description: DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
        },
        statusText: '📖 正在读取技能规范…',
        execute: async (rawArgs) => {
            const parsed = normalizeSkillNames(rawArgs.names);
            if (!parsed.ok) {
                return skillError(parsed.error);
            }

            const names = parsed.names;
            const traceArgument = names.join('、');
            const blocks: string[] = [];
            const missingNames: string[] = [];
            const capRejectedNames: string[] = [];
            let newlyLoadedCount = 0;
            let alreadyLoadedCount = 0;
            let loadedBodyChars = 0;

            for (const name of names) {
                const skill = byName.get(name);
                if (skill === undefined) {
                    missingNames.push(name);
                    blocks.push(
                        `[skill] \`${name}\` 不可用：没有这个可用技能，只能加载「可用技能」目录中列出的名字。`
                    );
                    continue;
                }

                if (options.state.hasLoaded(skill.name)) {
                    alreadyLoadedCount += 1;
                    blocks.push(`本次回复已加载过 \`${skill.name}\` v${skill.version}，内容同上。`);
                    continue;
                }

                if (options.state.loadedNames.size >= MAX_SKILLS_PER_REPLY) {
                    capRejectedNames.push(skill.name);
                    blocks.push(
                        `[skill] \`${skill.name}\` 未加载：本次回复最多加载 ${MAX_SKILLS_PER_REPLY} 个不同技能，已达上限。`
                    );
                    continue;
                }

                options.state.markLoaded(skill.name);
                newlyLoadedCount += 1;
                loadedBodyChars += Array.from(skill.body).length;
                blocks.push(`[skill] ${skill.name} v${skill.version}（来源：仓库技能）\n---\n${skill.body}`);
            }

            const anySucceeded = newlyLoadedCount > 0 || alreadyLoadedCount > 0;
            if (!anySucceeded) {
                if (capRejectedNames.length > 0 && missingNames.length === 0) {
                    return skillError(
                        `本次回复最多加载 ${MAX_SKILLS_PER_REPLY} 个不同技能，已达上限（${[...options.state.loadedNames].join('、')}）。`,
                        traceArgument,
                        '已达上限'
                    );
                }
                const quoted = missingNames.map((name) => `"${name}"`).join('、');
                return skillError(
                    `没有名为 ${quoted} 的可用技能。可用的技能见本条消息末尾的「可用技能」一节；只能加载其中列出的名字。`,
                    traceArgument,
                    '不可用'
                );
            }

            return {
                content: `${RESULT_HEADER}\n\n${blocks.join('\n\n')}`,
                isError: false,
                images: [],
                record: null,
                trace: {
                    argument: traceArgument,
                    result: traceParts(
                        newlyLoadedCount > 0 ? `加载 ${newlyLoadedCount} 个` : null,
                        alreadyLoadedCount > 0 ? `${alreadyLoadedCount} 个已加载` : null,
                        missingNames.length > 0 ? `${missingNames.length} 个不可用` : null,
                        capRejectedNames.length > 0 ? `${capRejectedNames.length} 个超上限` : null,
                        loadedBodyChars > 0 ? traceChars(loadedBodyChars) : null
                    ),
                },
            };
        },
    };
};
