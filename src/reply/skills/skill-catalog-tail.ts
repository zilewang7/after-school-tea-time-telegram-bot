/**
 * L2 skill catalog section appended to the volatile tail of the trigger turn.
 *
 * Only lists names and short descriptions (<= 120 chars each, <= 1,200 chars total);
 * nothing is injected when no skill is available for the turn.
 */
import type { UnifiedMessage } from '../../ai/types.js';
import { appendVolatileSection } from '../workspace/volatile-section.js';
import type { SkillEntry } from './skill-types.js';

export const SKILL_CATALOG_MAX_CHARS = 1200;
export const SKILL_CATALOG_DESCRIPTION_MAX_CHARS = 120;

const CATALOG_HEADER =
    '[system] 可用技能（需要以下工具规范或细则时，先调用 load_skill(names=[...]) 一次加载所需技能全文，再调用对应工具）：';

const charsOf = (text: string): number => Array.from(text).length;

const truncateDescription = (description: string): string => {
    const collapsed = description.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    const chars = Array.from(collapsed);
    if (chars.length <= SKILL_CATALOG_DESCRIPTION_MAX_CHARS) return collapsed;
    return `${chars.slice(0, SKILL_CATALOG_DESCRIPTION_MAX_CHARS - 1).join('')}…`;
};

const omittedLineOf = (count: number): string =>
    `- 还有 ${count} 个可用技能未列出。`;

/**
 * Build the `[system] 可用技能` catalog section, or null when `skills` is empty.
 */
export const buildSkillCatalogSection = (skills: readonly SkillEntry[]): string | null => {
    if (skills.length === 0) return null;

    const lines: string[] = [CATALOG_HEADER];
    let usedChars = charsOf(CATALOG_HEADER);
    let listedCount = 0;

    for (let index = 0; index < skills.length; index += 1) {
        const skill = skills[index];
        if (skill === undefined) continue;
        const line = `- \`${skill.name}\`：${truncateDescription(skill.description)}`;
        const remainingIfSkipped = skills.length - index;
        // Reserve room for the omission notice if more entries follow
        const reserve =
            remainingIfSkipped > 1 ? 1 + charsOf(omittedLineOf(remainingIfSkipped)) : 0;
        if (usedChars + 1 + charsOf(line) + reserve > SKILL_CATALOG_MAX_CHARS) {
            break;
        }
        lines.push(line);
        usedChars += 1 + charsOf(line);
        listedCount += 1;
    }

    const omittedCount = skills.length - listedCount;
    if (omittedCount > 0) {
        const footer = omittedLineOf(omittedCount);
        if (usedChars + 1 + charsOf(footer) <= SKILL_CATALOG_MAX_CHARS) {
            lines.push(footer);
        }
    }

    return lines.join('\n');
};

/** Append the skill catalog section to the trigger message when skills are available */
export const appendSkillCatalogTail = (
    messages: UnifiedMessage[],
    triggerTurnIndex: number,
    skills: readonly SkillEntry[]
): void => {
    const section = buildSkillCatalogSection(skills);
    if (section === null) return;
    appendVolatileSection(messages, triggerTurnIndex, section);
};
