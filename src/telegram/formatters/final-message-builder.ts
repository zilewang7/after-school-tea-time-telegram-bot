import type { AgentStats, GroundingData } from '../../ai/types.js';
import { escapeMarkdownV2, toTelegramMarkdown } from './markdown-formatter.js';
import { formatAgentStatsSections } from './agent-stats-formatter.js';
import { formatGroundingSections } from './grounding-formatter.js';
import { getTelegramVisibleLength, smartSplit } from './smart-splitter.js';

const TELEGRAM_MAX_LENGTH = 4000;
const THINKING_PREFIX = '**>';
const THINKING_SUFFIX = '||';
// Visible length overhead for an expandable blockquote chunk:
// the leading `>` counts as 1 visible (idx 2 isn't preceded by `\n`).
const THINKING_WRAP_VISIBLE_OVERHEAD = 1;

export interface FinalMessageBuildOptions {
    text: string;
    thinking?: string;
    groundingData?: GroundingData[];
    agentStats?: AgentStats;
    wasStoppedByUser?: boolean;
    safe?: boolean;
    maxLength?: number;
}

const stripLeadingNewlines = (text: string): string => text.replace(/^\n+/, '');

/**
 * Split thinking content into self-closing expandable blockquote chunks.
 * Each chunk is wrapped with **>...|| so it renders as a collapsible block.
 */
const splitThinkingIntoCollapsedChunks = (thinking: string, maxLength: number): string[] => {
    if (!thinking) return [];

    const lines = thinking.split('\n');
    const chunks: string[] = [];
    let currentLines: string[] = [];
    let currentVisibleLength = 0;

    const flushChunk = (): void => {
        if (currentLines.length === 0) return;
        const escapedLines = currentLines.map((line) => escapeMarkdownV2(line));
        const chunk = THINKING_PREFIX + escapedLines.join('\n>') + THINKING_SUFFIX;
        chunks.push(chunk);
        currentLines = [];
        currentVisibleLength = 0;
    };

    for (const line of lines) {
        const escapedLine = escapeMarkdownV2(line);
        // Visible length of this line: the actual text content (without escape backslashes)
        const lineVisibleLen = line.length;
        // +1 for the `>` prefix, +1 for the newline separator between lines
        const addedVisible = lineVisibleLen + 1 + (currentLines.length > 0 ? 1 : 0);

        if (currentLines.length > 0 && currentVisibleLength + addedVisible + THINKING_WRAP_VISIBLE_OVERHEAD > maxLength) {
            flushChunk();
        }

        // If a single line itself exceeds maxLength, split it
        if (lineVisibleLen + THINKING_WRAP_VISIBLE_OVERHEAD + 1 > maxLength) {
            flushChunk();
            const { currentPart, remaining } = smartSplit(escapedLine, maxLength - 10);
            chunks.push(THINKING_PREFIX + currentPart + THINKING_SUFFIX);
            if (remaining) {
                // Recursively handle remaining as a new "line"
                const subChunks = splitThinkingIntoCollapsedChunks(remaining, maxLength);
                chunks.push(...subChunks);
            }
            continue;
        }

        currentLines.push(line);
        currentVisibleLength += addedVisible;
    }

    flushChunk();
    return chunks;
};

/**
 * Split formatted text into chunks respecting visible length limits
 */
const splitTextIntoChunks = (text: string, maxLength: number): string[] => {
    if (!text) return [];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining) {
        if (getTelegramVisibleLength(remaining) <= maxLength) {
            chunks.push(remaining);
            break;
        }

        const split = smartSplit(remaining, maxLength);
        chunks.push(split.currentPart);
        remaining = split.remaining;
    }

    return chunks;
};

const appendSectionToChunks = (
    chunks: string[],
    section: string,
    maxLength: number
): void => {
    if (!section) return;

    const normalizedSection = chunks.length ? section : stripLeadingNewlines(section);

    if (!chunks.length) {
        if (normalizedSection.length <= maxLength) {
            chunks.push(normalizedSection);
            return;
        }

        chunks.push(...splitTextIntoChunks(normalizedSection, maxLength));
        return;
    }

    const lastIndex = chunks.length - 1;
    const lastChunk = chunks[lastIndex] ?? '';

    if (getTelegramVisibleLength(lastChunk + section) <= maxLength) {
        chunks[lastIndex] = lastChunk + section;
        return;
    }

    if (normalizedSection.length <= maxLength) {
        chunks.push(normalizedSection);
        return;
    }

    chunks.push(...splitTextIntoChunks(normalizedSection, maxLength));
};

export const buildFinalMessageChunks = (
    options: FinalMessageBuildOptions
): string[] => {
    const {
        text,
        thinking,
        groundingData,
        agentStats,
        wasStoppedByUser,
        safe = false,
        maxLength = TELEGRAM_MAX_LENGTH,
    } = options;

    const chunks: string[] = [];

    // 1. Split thinking into self-closing expandable blockquote chunks
    if (thinking) {
        const thinkingChunks = splitThinkingIntoCollapsedChunks(thinking, maxLength);
        chunks.push(...thinkingChunks);
    }

    // 2. Format and split text
    if (text) {
        const formattedText = safe ? escapeMarkdownV2(text) : toTelegramMarkdown(text);
        const textChunks = splitTextIntoChunks(formattedText, maxLength);

        if (textChunks.length > 0) {
            // Try to append first text chunk to last thinking chunk if it fits
            if (chunks.length > 0) {
                const lastIndex = chunks.length - 1;
                const lastChunk = chunks[lastIndex] ?? '';
                const firstText = textChunks[0] ?? '';
                const combined = lastChunk + '\n' + firstText;

                if (getTelegramVisibleLength(combined) <= maxLength) {
                    chunks[lastIndex] = combined;
                    textChunks.shift();
                }
            }

            chunks.push(...textChunks);
        }
    }

    // 3. Append metadata sections
    const sections = [
        ...formatAgentStatsSections(agentStats),
        ...(wasStoppedByUser ? ['\n\n\\[stopped\\]'] : []),
        ...formatGroundingSections(groundingData ?? []),
    ];

    for (const section of sections) {
        appendSectionToChunks(chunks, section, maxLength);
    }

    return chunks.filter((chunk) => chunk.length > 0);
};

export const buildFinalMessage = (
    options: FinalMessageBuildOptions
): string => buildFinalMessageChunks(options).join('');
