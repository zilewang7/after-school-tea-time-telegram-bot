import type { MessageEntity } from 'grammy/types';
import type { MessageAttachmentSource } from '../db/messageAttachmentDTO.js';

export interface CustomEmojiOccurrence {
  ordinal: number;
  source: MessageAttachmentSource;
  customEmojiId: string;
  offsetUtf16: number | null;
  lengthUtf16: number | null;
  fallbackText: string;
}

const MAX_CUSTOM_EMOJI_OCCURRENCES = 64;

const collectEntityOccurrences = (
  text: string,
  entities: MessageEntity[] | undefined,
  source: 'text' | 'caption'
): CustomEmojiOccurrence[] => {
  if (!entities) return [];

  const occurrences: CustomEmojiOccurrence[] = [];
  const customEmojiEntities = entities
    .filter((entity) => entity.type === 'custom_emoji')
    .sort((left, right) => left.offset - right.offset);
  for (const entity of customEmojiEntities) {
    occurrences.push({
      ordinal: occurrences.length,
      source,
      customEmojiId: entity.custom_emoji_id,
      offsetUtf16: entity.offset,
      lengthUtf16: entity.length,
      fallbackText: text.slice(entity.offset, entity.offset + entity.length),
    });
    if (occurrences.length >= MAX_CUSTOM_EMOJI_OCCURRENCES) break;
  }
  return occurrences;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

interface CustomEmojiSourceMessage {
  text?: string;
  entities?: MessageEntity[];
  caption?: string;
  caption_entities?: MessageEntity[];
  rich_message?: { blocks: unknown[] };
}

const collectRichOccurrences = (
  richMessage: NonNullable<CustomEmojiSourceMessage['rich_message']>
): CustomEmojiOccurrence[] => {
  const occurrences: CustomEmojiOccurrence[] = [];

  const visit = (value: unknown): void => {
    if (occurrences.length >= MAX_CUSTOM_EMOJI_OCCURRENCES) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;

    if (
      value.type === 'custom_emoji'
      && typeof value.custom_emoji_id === 'string'
      && typeof value.alternative_text === 'string'
    ) {
      occurrences.push({
        ordinal: occurrences.length,
        source: 'rich_message',
        customEmojiId: value.custom_emoji_id,
        offsetUtf16: null,
        lengthUtf16: null,
        fallbackText: value.alternative_text,
      });
      return;
    }

    for (const nested of Object.values(value)) visit(nested);
  };

  visit(richMessage.blocks);
  return occurrences;
};

/** Extract custom emojis from the same body source autoSave persists. */
export const extractCustomEmojiOccurrences = (
  message: CustomEmojiSourceMessage
): CustomEmojiOccurrence[] => {
  if (message.text) {
    return collectEntityOccurrences(message.text, message.entities, 'text');
  }
  if (message.caption) {
    return collectEntityOccurrences(message.caption, message.caption_entities, 'caption');
  }
  if (message.rich_message) {
    return collectRichOccurrences(message.rich_message);
  }
  return [];
};
