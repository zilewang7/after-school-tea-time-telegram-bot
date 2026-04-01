import type { AgentStats, GroundingData } from '../../ai/types';
import { formatResponse, formatResponseSafe } from './markdown-formatter';
import { formatAgentStatsSections } from './agent-stats-formatter';
import { formatGroundingSections } from './grounding-formatter';
import { getTelegramVisibleLength, smartSplit } from './smart-splitter';

const TELEGRAM_MAX_LENGTH = 4000;

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

const splitPlainTextIntoChunks = (text: string, maxLength: number): string[] => {
    if (!text) return [];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining) {
        if (remaining.length <= maxLength) {
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

        chunks.push(...splitPlainTextIntoChunks(normalizedSection, maxLength));
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

    chunks.push(...splitPlainTextIntoChunks(normalizedSection, maxLength));
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

    const body = safe
        ? formatResponseSafe(text || '', thinking)
        : formatResponse(text || '', thinking);

    const chunks = splitPlainTextIntoChunks(body, maxLength);
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
