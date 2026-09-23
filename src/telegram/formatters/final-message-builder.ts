/**
 * Final response assembly: collapsed thinking quote + markdown-rendered text
 * + tool-call / sources sections, composed as one entity message and then
 * split into chunks that fit both the length and entity budgets. Formatting
 * spanning a boundary is closed and reopened by splitMessage, so styles are
 * seamless across messages.
 */
import {
    concatMessages,
    renderMarkdown,
    splitMessage,
} from 'telegram-md-entities';
import type { RenderedMessage } from 'telegram-md-entities';
import type { AgentStats, GroundingData } from '../../ai/types.js';
import { buildToolRecordSections } from './tool-records-formatter.js';
import { buildGoogleSearchSections } from './google-search-formatter.js';
import { plainText } from './entity-text.js';
import { renderThinkingQuote } from './quoted-render.js';
import { linkifyContextNumbers, type ContextLinkResolver } from './context-links.js';

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
    /** Makes the `#N` context references clickable (display-only) */
    resolveContextLink?: ContextLinkResolver;
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
        resolveContextLink,
    } = options;

    const parts: (RenderedMessage | string)[] = [];

    if (thinking) {
        parts.push(renderThinkingQuote(thinking, { expandable: true }));
    }

    if (text) {
        if (parts.length) parts.push('\n');
        parts.push(renderMarkdown(text));
    }

    if (wasStoppedByUser) {
        parts.push('\n\n', plainText('[stopped]'));
    }

    // Records of the run: the merged tool-call blocks, plus Gemini's search
    // grounding in its own dedicated block
    const recordSections = [
        ...buildToolRecordSections(agentStats, groundingData ?? []),
        ...buildGoogleSearchSections(groundingData ?? []),
    ];
    for (const section of recordSections) {
        parts.push('\n', section);
    }

    if (!parts.length) return [];

    // Before the split, so the added link entities count against its budget
    const combined = linkifyContextNumbers(concatMessages(...parts), resolveContextLink);
    if (!combined.text.trim()) return [];

    return splitMessage(combined, {
        maxLength,
        maxEntities: TELEGRAM_MAX_ENTITIES,
    }).filter((chunk) => chunk.text.length > 0);
};
