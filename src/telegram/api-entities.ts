/**
 * Boundary conversion: telegram-md-entities' lenient MessageEntity shape →
 * grammy's discriminated-union MessageEntity, applied right before Bot API
 * calls. A text_link without a url (should not happen) is dropped rather
 * than risking a Bad Request.
 */
import type { MessageEntity as ApiMessageEntity } from 'grammy/types';
import type { MessageEntity as RenderedEntity } from 'telegram-md-entities';

export const toApiEntities = (
    entities: readonly RenderedEntity[]
): ApiMessageEntity[] => {
    const converted: ApiMessageEntity[] = [];

    for (const entity of entities) {
        const { type, offset, length } = entity;

        if (type === 'text_link') {
            if (entity.url) {
                converted.push({ type, offset, length, url: entity.url });
            }
        } else if (type === 'pre') {
            converted.push(
                entity.language
                    ? { type, offset, length, language: entity.language }
                    : { type, offset, length }
            );
        } else {
            converted.push({ type, offset, length });
        }
    }

    return converted;
};
