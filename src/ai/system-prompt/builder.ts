/**
 * Assemble the static system prompt.
 *
 * It is deliberately split from the runtime block (runtime-context.ts): the head
 * must be byte-identical for every request served by the same model, because
 * upstream prefix caches only hit when the prompt starts with the same bytes.
 * The volatile parts — current time, model id, user roster — are appended to the
 * newest message instead. One changing line in here would invalidate the whole
 * cached prefix for every reply.
 */
import { getModelCapabilities } from '../platform-factory.js';
import { getPreferencePrompt } from './preference.js';
import {
    buildFormatSection,
    CAPABILITIES_SECTION,
    NOTES_SECTION,
    ROSTER_SECTION,
} from './sections.js';

export const buildStaticSystemPrompt = (model: string): string => {
    const capabilities = getModelCapabilities(model);

    return [
        getPreferencePrompt(),
        ROSTER_SECTION,
        buildFormatSection({ includeOcrNote: !capabilities.supportsImageInput }),
        CAPABILITIES_SECTION,
        NOTES_SECTION,
    ]
        .filter((section) => section.length > 0)
        .join('\n\n');
};
