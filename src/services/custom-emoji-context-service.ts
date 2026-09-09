import type { UnifiedContentPart } from '../ai/types.js';
import type { MessageAttachment } from '../db/messageAttachmentDTO.js';
import { getCustomEmojiAttachmentsForMessages } from '../db/queries/message-attachment-queries.js';
import {
  getOrCreateCustomEmojiAtlas,
  type CustomEmojiAtlasSource,
} from './custom-emoji-service.js';

const DEFAULT_CONTEXT_LIMIT = 16;
const DEFAULT_CONTEXT_BYTES = 512 * 1024;
const ATLAS_ITEMS = 8;
const MAX_ANNOTATED_PER_MESSAGE = 16;
const MAX_ANNOTATED_CONTEXT = 64;
const MAX_ATLAS_OUTPUT_BYTES = 384 * 1024;
const CONTEXT_PLAN_TIMEOUT_MS = 1500;
const ATLAS_CIRCUIT_FAILURES = 3;
const ATLAS_CIRCUIT_COOLDOWN_MS = 60 * 1000;

export interface CustomEmojiContextPlan {
  annotations: Map<number, string>;
  atlasParts: UnifiedContentPart[];
}

const positiveIntegerEnv = (name: string, fallback: number, maximum: number): number => {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
};

const contextLimit = positiveIntegerEnv(
  'CUSTOM_EMOJI_CONTEXT_LIMIT',
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_CONTEXT_LIMIT
);
const contextBytes = positiveIntegerEnv(
  'CUSTOM_EMOJI_CONTEXT_BYTES',
  DEFAULT_CONTEXT_BYTES,
  640 * 1024
);
const contextPlanTimeoutMs = positiveIntegerEnv(
  'CUSTOM_EMOJI_CONTEXT_TIMEOUT_MS',
  CONTEXT_PLAN_TIMEOUT_MS,
  5000
);

let consecutiveAtlasFailures = 0;
let atlasCircuitOpenUntil = 0;

const chunksOf = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    chunks.push(items.slice(offset, offset + size));
  }
  return chunks;
};

const fallbackLabel = (text: string): string => {
  const compact = Array.from(text.trim()).slice(0, 8).join('');
  return JSON.stringify(compact || '?');
};

const statusDescription = (
  attachment: MessageAttachment,
  labelByEmojiId: ReadonlyMap<string, string>,
  visibleLabels: ReadonlySet<string>,
  supportsImageInput: boolean
): string => {
  const fallback = fallbackLabel(attachment.fallbackText);
  const label = labelByEmojiId.get(attachment.customEmojiId);
  if (label && visibleLabels.has(label)) {
    return `${label} replaces fallback ${fallback}`;
  }
  if (!supportsImageInput) {
    return `custom emoji fallback ${fallback} (visual unavailable to this model)`;
  }
  if (attachment.status === 'omitted') {
    return `custom emoji fallback ${fallback} (visual omitted by per-message budget)`;
  }
  if (attachment.status === 'failed') {
    return `custom emoji fallback ${fallback} (visual fetch failed)`;
  }
  if (attachment.status === 'pending') {
    return `custom emoji fallback ${fallback} (visual not ready)`;
  }
  return `custom emoji fallback ${fallback} (visual omitted by context budget)`;
};

const buildAnnotations = (
  messageIds: number[],
  attachmentsByMessage: ReadonlyMap<number, MessageAttachment[]>,
  labelByEmojiId: ReadonlyMap<string, string>,
  visibleLabels: ReadonlySet<string>,
  supportsImageInput: boolean
): Map<number, string> => {
  const annotations = new Map<number, string>();
  let remainingContextOccurrences = MAX_ANNOTATED_CONTEXT;

  for (const messageId of [...messageIds].reverse()) {
    if (remainingContextOccurrences === 0) break;
    const attachments = attachmentsByMessage.get(messageId) ?? [];
    if (attachments.length === 0) continue;
    const selected = attachments.slice(
      0,
      Math.min(MAX_ANNOTATED_PER_MESSAGE, remainingContextOccurrences)
    );
    remainingContextOccurrences -= selected.length;
    const descriptions = selected.map((attachment) =>
      statusDescription(attachment, labelByEmojiId, visibleLabels, supportsImageInput)
    );
    if (selected.length < attachments.length) {
      descriptions.push(`${attachments.length - selected.length} more occurrence(s) omitted`);
    }
    const hasVisible = descriptions.some((description) => /^E\d+ /.test(description));
    const atlasNote = hasVisible
      ? ' Match E# against the labeled custom-emoji atlas attached to the current message.'
      : '';
    annotations.set(
      messageId,
      `[system] Telegram custom emoji occurrences in this message, in reading order: ${descriptions.join('; ')}.${atlasNote} Treat them as visual tone and do not narrate them unless relevant.`
    );
  }
  return annotations;
};

const selectAtlasSources = (
  messageIds: number[],
  attachmentsByMessage: ReadonlyMap<number, MessageAttachment[]>
): { sources: CustomEmojiAtlasSource[]; labelByEmojiId: Map<string, string> } => {
  const sources: CustomEmojiAtlasSource[] = [];
  const labelByEmojiId = new Map<string, string>();

  for (const messageId of [...messageIds].reverse()) {
    const attachments = attachmentsByMessage.get(messageId) ?? [];
    for (const attachment of attachments) {
      if (
        attachment.status !== 'ready'
        || !attachment.mediaKey
        || labelByEmojiId.has(attachment.customEmojiId)
      ) {
        continue;
      }
      const label = `E${labelByEmojiId.size + 1}`;
      labelByEmojiId.set(attachment.customEmojiId, label);
      sources.push({
        label,
        customEmojiId: attachment.customEmojiId,
        mediaKey: attachment.mediaKey,
      });
      if (sources.length >= contextLimit) return { sources, labelByEmojiId };
    }
  }
  return { sources, labelByEmojiId };
};

const withDeadline = async <T>(
  operation: Promise<T>,
  deadline: number,
  description: string
): Promise<T> => {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error(`${description} exceeded its deadline`);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${description} exceeded its deadline`)),
          remainingMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const noteAtlasFailure = (): void => {
  consecutiveAtlasFailures += 1;
  if (consecutiveAtlasFailures >= ATLAS_CIRCUIT_FAILURES) {
    atlasCircuitOpenUntil = Date.now() + ATLAS_CIRCUIT_COOLDOWN_MS;
    consecutiveAtlasFailures = 0;
    console.warn('[custom-emoji] atlas circuit opened for 60 seconds');
  }
};

const noteAtlasSuccess = (): void => {
  consecutiveAtlasFailures = 0;
  atlasCircuitOpenUntil = 0;
};

const buildAtlasParts = async (
  sources: CustomEmojiAtlasSource[],
  deadline: number
): Promise<{ parts: UnifiedContentPart[]; visibleLabels: Set<string> }> => {
  const visibleLabels = new Set<string>();
  const parts: UnifiedContentPart[] = [];
  if (Date.now() < atlasCircuitOpenUntil) return { parts, visibleLabels };

  let usedBytes = 0;
  for (const atlasSources of chunksOf(sources, ATLAS_ITEMS)) {
    const remainingBytes = contextBytes - usedBytes;
    if (remainingBytes <= 0) break;
    const controller = new AbortController();
    const abortTimer = setTimeout(
      () => controller.abort(new Error('custom emoji context deadline exceeded')),
      Math.max(1, deadline - Date.now())
    );
    let atlas: { data: Buffer; mediaKey: string } | null;
    try {
      atlas = await withDeadline(
        getOrCreateCustomEmojiAtlas(atlasSources, controller.signal),
        deadline,
        'custom emoji atlas'
      );
    } finally {
      clearTimeout(abortTimer);
    }
    if (!atlas) {
      noteAtlasFailure();
      continue;
    }
    if (atlas.data.length > MAX_ATLAS_OUTPUT_BYTES) {
      noteAtlasFailure();
      break;
    }
    if (atlas.data.length > remainingBytes) break;
    noteAtlasSuccess();
    usedBytes += atlas.data.length;
    atlasSources.forEach((source) => visibleLabels.add(source.label));
    parts.push({
      type: 'image',
      imageData: atlas.data.toString('base64'),
      sizeBytes: atlas.data.length,
      mimeType: 'image/png',
      mediaKind: 'custom_emoji_atlas',
    });
  }
  return { parts, visibleLabels };
};

/** Build globally deduplicated emoji atlases plus per-message occurrence legends. */
export const buildCustomEmojiContextPlan = async (
  chatId: number,
  messageIds: number[],
  supportsImageInput: boolean
): Promise<CustomEmojiContextPlan> => {
  if (process.env.CUSTOM_EMOJI_ENABLED === '0') {
    return { annotations: new Map(), atlasParts: [] };
  }

  const deadline = Date.now() + contextPlanTimeoutMs;
  let attachmentsByMessage: Map<number, MessageAttachment[]>;
  try {
    attachmentsByMessage = await withDeadline(
      getCustomEmojiAttachmentsForMessages(chatId, messageIds),
      deadline,
      'custom emoji manifest query'
    );
  } catch (error) {
    console.error('[custom-emoji] context manifest unavailable; continuing without visuals:', error);
    return { annotations: new Map(), atlasParts: [] };
  }
  if (attachmentsByMessage.size === 0) {
    return { annotations: new Map(), atlasParts: [] };
  }

  if (!supportsImageInput) {
    return {
      annotations: buildAnnotations(
        messageIds,
        attachmentsByMessage,
        new Map(),
        new Set(),
        false
      ),
      atlasParts: [],
    };
  }

  const { sources, labelByEmojiId } = selectAtlasSources(messageIds, attachmentsByMessage);
  try {
    const atlas = await buildAtlasParts(sources, deadline);
    return {
      annotations: buildAnnotations(
        messageIds,
        attachmentsByMessage,
        labelByEmojiId,
        atlas.visibleLabels,
        true
      ),
      atlasParts: atlas.parts,
    };
  } catch (error) {
    noteAtlasFailure();
    console.error('[custom-emoji] atlas unavailable; continuing with fallback text:', error);
    return {
      annotations: buildAnnotations(
        messageIds,
        attachmentsByMessage,
        labelByEmojiId,
        new Set(),
        true
      ),
      atlasParts: [],
    };
  }
};
