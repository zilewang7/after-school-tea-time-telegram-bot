/**
 * Final response assembly: collapsed thinking quote + markdown-rendered text
 * + agent-stats / grounding sections, composed as one entity message and then
 * split into chunks that fit both the length and entity budgets. Formatting
 * spanning a boundary is closed and reopened by splitMessage, so styles are
 * seamless across messages.
 */
import {
    concatMessages,
    renderMarkdown,
    splitMessage,
    wrapInBlockquote,
} from 'telegram-md-entities';
import type { RenderedMessage } from 'telegram-md-entities';
import type { AgentStats, GroundingData } from '../../ai/types.js';
import { buildAgentStatsSections } from './agent-stats-formatter.js';
import { buildGroundingSections } from './grounding-formatter.js';
import { plainText } from './entity-text.js';

/** Safe per-message length budget (below Telegram's 4096 hard limit) */
const TELEGRAM_MAX_LENGTH = 4000;
/** Per-message entity budget (the server silently drops entities past ~100) */
const TELEGRAM_MAX_ENTITIES = 90;

export interface FinalMessageBuildOptions {
    text: string;
    thinking?: string;
    groundingData?: GroundingData[];
    agentStats?: AgentStats;
    wasStoppedByUser?: boolean;
    maxLength?: number;
}

export const buildFinalMessages = (
    options: FinalMessageBuildOptions
): RenderedMessage[] => {
    const {
        text,
        thinking,
        groundingData,
        agentStats,
        wasStoppedByUser,
        maxLength = TELEGRAM_MAX_LENGTH,
    } = options;

    const parts: (RenderedMessage | string)[] = [];

    if (thinking) {
        parts.push(wrapInBlockquote(renderMarkdown(thinking), true));
    }

    if (text) {
        if (parts.length) parts.push('\n');
        parts.push(renderMarkdown(text));
    }

    for (const section of buildAgentStatsSections(agentStats)) {
        parts.push('\n', section);
    }

    if (wasStoppedByUser) {
        parts.push('\n\n', plainText('[stopped]'));
    }

    for (const section of buildGroundingSections(groundingData ?? [])) {
        parts.push('\n', section);
    }

    if (!parts.length) return [];

    const combined = concatMessages(...parts);
    if (!combined.text.trim()) return [];

    return splitMessage(combined, {
        maxLength,
        maxEntities: TELEGRAM_MAX_ENTITIES,
    }).filter((chunk) => chunk.text.length > 0);
};
