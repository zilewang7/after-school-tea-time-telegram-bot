import type { AgentStats } from '../../ai/types';
import { escapeMarkdownV2 } from './markdown-formatter';

const truncate = (text: string, maxLength: number = 120): string => {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 1) + '…';
};

export const formatAgentStats = (stats?: AgentStats): string => {
    if (!stats) return '';

    const lines: string[] = [];

    if (stats.mode) {
        lines.push(`mode: ${escapeMarkdownV2(stats.mode)}`);
    }

    // if (typeof stats.reasoningTokens === 'number' && stats.reasoningTokens > 0) {
    //     lines.push(`reasoning tokens: ${stats.reasoningTokens}`);
    // }

    if (stats.toolUsage?.length) {
        const toolUsage = stats.toolUsage
            .filter((tool) => tool.name && tool.count > 0)
            .map((tool) => `${escapeMarkdownV2(tool.name)} x${tool.count}`)
            .join(' \\| ');

        if (toolUsage) {
            lines.push(`tool usage: ${toolUsage}`);
        }
    }

    stats.codeInterpreterSummary?.forEach((summary, index) => {
        if (!summary?.trim()) return;
        const label = index === 0 ? 'code interpreter' : `code interpreter ${index + 1}`;
        lines.push(`${label}: ${escapeMarkdownV2(truncate(summary.trim()))}`);
    });

    if (!lines.length) {
        return '';
    }

    return `\n*Agent Stats*\n**>${lines.join('\n>')}||`;
};

export const formatAgentStatsSections = (stats?: AgentStats): string[] => {
    const section = formatAgentStats(stats);
    return section ? [section] : [];
};

export const appendAgentStatsToMessage = (
    message: string,
    stats?: AgentStats
): string => {
    const section = formatAgentStats(stats);
    if (!section) return message;
    return message + section;
};
