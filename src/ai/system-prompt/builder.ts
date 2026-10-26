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
import { getToolConfig } from '../../config/tool-config.js';
import { getPreferencePrompt } from './preference.js';
import {
    buildCapabilitiesSection,
    buildFormatSection,
    NOTES_SECTION,
    ROSTER_SECTION,
} from './sections.js';

export interface StaticPromptOptions {
    /**
     * send_sms_to_owner is offered this turn. Decided per model and chat only,
     * so the prompt stays byte-identical across requests of one conversation.
     */
    readonly sms?: boolean;
    /** search_images / send_image are offered this turn */
    readonly imageTools?: boolean;
    /** fetch_image is offered this turn */
    readonly imageFetch?: boolean;
    /** search_by_image is offered this turn */
    readonly imageReverseSearch?: boolean;
    /** generate_image is offered this turn */
    readonly imageGenerate?: boolean;
    /** send_sticker is offered this turn */
    readonly stickerTools?: boolean;
}

export const buildStaticSystemPrompt = (model: string, options: StaticPromptOptions = {}): string => {
    const capabilities = getModelCapabilities(model);

    return [
        getPreferencePrompt(),
        ROSTER_SECTION,
        buildFormatSection({ includeOcrNote: !capabilities.supportsImageInput }),
        buildCapabilitiesSection({
            smsOwner: options.sms === true ? getToolConfig().owner : null,
            imageTools: options.imageTools === true,
            imageFetch: options.imageFetch === true,
            imageReverseSearch: options.imageReverseSearch === true,
            imageGenerate: options.imageGenerate === true,
            stickerTools: options.stickerTools === true,
        }),
        NOTES_SECTION,
    ]
        .filter((section) => section.length > 0)
        .join('\n\n');
};
