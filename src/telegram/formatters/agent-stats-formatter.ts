/**
 * Agent stats section: bold title + expandable blockquote, built directly as
 * entities (no markdown round-trip, nothing to escape).
 */
import { concatMessages, wrapInBlockquote } from 'telegram-md-entities';
import type { RenderedMessage } from 'telegram-md-entities';
import type { AgentStats } from '../../ai/types.js';
import { boldText, plainText } from './entity-text.js';

const truncate = (text: string, maxLength: number = 120): string => {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 1) + '…';
};

export const buildAgentStatsSections = (stats?: AgentStats): RenderedMessage[] => {
    if (!stats) return [];

    const lines: string[] = [];

    if (stats.mode) {
        lines.push(`mode: ${stats.mode}`);
    }

    if (stats.toolUsage?.length) {
        const toolUsage = stats.toolUsage
            .filter((tool) => tool.name && tool.count > 0)
            .map((tool) => `${tool.name} x${tool.count}`)
            .join(' | ');

        if (toolUsage) {
            lines.push(`tool usage: ${toolUsage}`);
        }
    }

    stats.codeInterpreterSummary?.forEach((summary, index) => {
        if (!summary?.trim()) return;
        const label = index === 0 ? 'code interpreter' : `code interpreter ${index + 1}`;
        lines.push(`${label}: ${truncate(summary.trim())}`);
    });

    if (!lines.length) return [];

    return [
        concatMessages(
            boldText('Agent Stats'),
            '\n',
            wrapInBlockquote(plainText(lines.join('\n')), true)
        ),
    ];
};
