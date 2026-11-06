/**
 * Which capability lines the static head carries, from the turn's tool
 * availability. One mapping for the first answer and the retry, so the two
 * never drift apart again (the retry once lost the harness issue line).
 */
import type { StaticPromptOptions } from '../ai/system-prompt/index.js';
import type { ToolAvailability } from './tools/index.js';

export const buildStaticPromptOptions = (availability: ToolAvailability): StaticPromptOptions => ({
    sms: availability.sms,
    imageTools: availability.imageSearch,
    imageFetch: availability.imageFetch,
    imageReverseSearch: availability.imageReverseSearch,
    imageGenerate: availability.image,
    stickerTools: availability.sticker,
    historyTools: availability.history,
    fileTools: availability.file,
    harnessIssues: availability.harnessIssues,
});
