/**
 * Large media: files too big to inline, referenced by their gs:// URI
 * (UnifiedContentPart.fileUri) and fetched by the provider itself.
 */
import type { UnifiedMessage } from './types.js';

/** Some message part references large media */
export const carriesLargeMedia = (messages: readonly UnifiedMessage[]): boolean =>
    messages.some((message) => message.content.some((part) => part.type === 'media' && Boolean(part.fileUri)));
