import type { Sticker } from 'grammy/types';
import { createHash } from 'node:crypto';
import { CustomEmojiAsset, type CustomEmojiAssetKind } from '../db/customEmojiAssetDTO.js';
import { withBusyRetry } from '../db/busy-retry.js';
import {
  failOrphanedPendingCustomEmojiAttachments,
  failPendingCustomEmojiAttachments,
  getPendingCustomEmojiAttachments,
  getRecoverableCustomEmojiRevisions,
  markCustomEmojiAttachments,
} from '../db/queries/message-attachment-queries.js';
import type { MessageRevisionToken } from '../db/queries/message-revision-queries.js';
import { getCachedMedia, putCachedMedia } from './media-cache-service.js';
import {
  createCustomEmojiAtlas,
  createCustomEmojiPreview,
  type CustomEmojiAtlasItem,
} from './tgs-client.js';
import {
  downloadTelegramFile,
  toTelegramApiAbortSignal,
  type TelegramApiAbortSignal,
  type TelegramFileClient,
} from './telegram-file-service.js';

export interface CustomEmojiBotClient extends TelegramFileClient {
  api: TelegramFileClient['api'] & {
    getCustomEmojiStickers(
      customEmojiIds: string[],
      signal?: TelegramApiAbortSignal
    ): Promise<Sticker[]>;
  };
}

const positiveIntegerEnv = (name: string, fallback: number, maximum: number): number => {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
};

const CUSTOM_EMOJI_BATCH_SIZE = 200;
const FAILED_ASSET_RETRY_MS = 10 * 60 * 1000;
const ATLAS_VERSION = 'v1';
const PREVIEW_VERSION = 'v1';
const PREVIEW_CONCURRENCY = positiveIntegerEnv('CUSTOM_EMOJI_PREVIEW_CONCURRENCY', 3, 8);
const ACQUISITION_CONCURRENCY = positiveIntegerEnv('CUSTOM_EMOJI_ACQUISITION_CONCURRENCY', 3, 8);
const ACQUISITION_QUEUE_LIMIT = positiveIntegerEnv('CUSTOM_EMOJI_ACQUISITION_QUEUE', 64, 256);
const TELEGRAM_API_CONCURRENCY = positiveIntegerEnv('CUSTOM_EMOJI_TELEGRAM_CONCURRENCY', 3, 8);
const TELEGRAM_API_QUEUE_LIMIT = positiveIntegerEnv('CUSTOM_EMOJI_TELEGRAM_QUEUE', 64, 256);
const RECOVERY_BATCH_SIZE = positiveIntegerEnv('CUSTOM_EMOJI_RECOVERY_BATCH', 32, 128);
const RECOVERY_INTERVAL_MS = positiveIntegerEnv(
  'CUSTOM_EMOJI_RECOVERY_INTERVAL_MS',
  5 * 60 * 1000,
  60 * 60 * 1000
);
const ACQUISITION_TIMEOUT_MS = positiveIntegerEnv(
  'CUSTOM_EMOJI_ACQUISITION_TIMEOUT_MS',
  55000,
  60000
);
const defaultAssetTimeoutMs = Math.max(
  250,
  Math.min(
    45000,
    ACQUISITION_TIMEOUT_MS - Math.min(5000, Math.floor(ACQUISITION_TIMEOUT_MS / 4))
  )
);
const ASSET_TIMEOUT_MS = positiveIntegerEnv(
  'CUSTOM_EMOJI_ASSET_TIMEOUT_MS',
  defaultAssetTimeoutMs,
  ACQUISITION_TIMEOUT_MS
);
const inFlightAssets = new Map<string, Promise<ResolvedCustomEmojiAsset>>();
const inFlightRevisions = new Map<string, Promise<void>>();

interface PermitWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface PermitPool {
  active: number;
  waiters: PermitWaiter[];
  concurrency: number;
  queueLimit: number;
  label: string;
}

const previewPool: PermitPool = {
  active: 0,
  waiters: [],
  concurrency: PREVIEW_CONCURRENCY,
  queueLimit: PREVIEW_CONCURRENCY * ACQUISITION_CONCURRENCY * 8,
  label: 'preview',
};
const acquisitionPool: PermitPool = {
  active: 0,
  waiters: [],
  concurrency: ACQUISITION_CONCURRENCY,
  queueLimit: ACQUISITION_QUEUE_LIMIT,
  label: 'acquisition',
};
const telegramApiPool: PermitPool = {
  active: 0,
  waiters: [],
  concurrency: TELEGRAM_API_CONCURRENCY,
  queueLimit: TELEGRAM_API_QUEUE_LIMIT,
  label: 'Telegram API',
};

const acquirePermit = async (pool: PermitPool, signal?: AbortSignal): Promise<void> => {
  signal?.throwIfAborted();
  if (pool.active < pool.concurrency) {
    pool.active += 1;
    return;
  }
  if (pool.waiters.length >= pool.queueLimit) {
    throw new Error(`custom emoji ${pool.label} queue is full`);
  }
  await new Promise<void>((resolve, reject) => {
    const waiter: PermitWaiter = {
      resolve,
      reject: (error) => reject(error),
      signal,
    };
    waiter.onAbort = () => {
      const index = pool.waiters.indexOf(waiter);
      if (index >= 0) pool.waiters.splice(index, 1);
      waiter.reject(new Error(`custom emoji ${pool.label} wait aborted`));
    };
    pool.waiters.push(waiter);
    signal?.addEventListener('abort', waiter.onAbort, { once: true });
    if (signal?.aborted) waiter.onAbort();
  });
};

const releasePermit = (pool: PermitPool): void => {
  for (;;) {
    const next = pool.waiters.shift();
    if (!next) {
      pool.active -= 1;
      return;
    }
    if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort);
    if (next.signal?.aborted) continue;
    next.resolve();
    return;
  }
};

const withPermit = async <T>(
  pool: PermitPool,
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> => {
  await acquirePermit(pool, signal);
  try {
    signal?.throwIfAborted();
    return await operation();
  } finally {
    releasePermit(pool);
  }
};

const withAbort = async <T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return operation;
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        onAbort = () => reject(new Error('custom emoji acquisition aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
};

const createAcquisitionController = (
  parentSignal?: AbortSignal,
  timeoutMs = ACQUISITION_TIMEOUT_MS
): { signal: AbortSignal; dispose: () => void } => {
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    if (parentSignal?.aborted) abortFromParent();
  }
  const timer = setTimeout(
    () => controller.abort(new Error('custom emoji acquisition deadline exceeded')),
    timeoutMs
  );
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
};

interface ResolvedCustomEmojiAsset {
  customEmojiId: string;
  mediaKey: string | null;
  failureReason: string | null;
}

export interface CustomEmojiAtlasSource {
  label: string;
  customEmojiId: string;
  mediaKey: string;
}

const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    chunks.push(items.slice(offset, offset + size));
  }
  return chunks;
};

const assetKindOf = (sticker: Sticker): CustomEmojiAssetKind => {
  if (sticker.is_video) return 'video';
  if (sticker.is_animated) return 'animated';
  return 'static';
};

const needsRepaintingOf = (sticker: Sticker): boolean =>
  'needs_repainting' in sticker && sticker.needs_repainting === true;

const sourceMimeOf = (
  sticker: Sticker,
  sourcePath: string,
  bytes: Buffer
): string => {
  if (sticker.is_video) return 'video/webm';
  if (sticker.is_animated) return 'application/x-tgsticker';
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.subarray(0, pngMagic.length).equals(pngMagic)) return 'image/png';
  return sourcePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/webp';
};

const failureText = (error: unknown): string =>
  error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);

const saveFailedAsset = async (
  customEmojiId: string,
  reason: string,
  sticker?: Sticker
): Promise<ResolvedCustomEmojiAsset> => {
  await withBusyRetry(() => CustomEmojiAsset.upsert({
    customEmojiId,
    fileId: sticker?.file_id ?? null,
    fileUniqueId: sticker?.file_unique_id ?? null,
    kind: sticker ? assetKindOf(sticker) : null,
    sourceMime: null,
    previewMediaKey: null,
    fallbackEmoji: sticker?.emoji ?? null,
    needsRepainting: sticker ? needsRepaintingOf(sticker) : null,
    status: 'failed',
    failureReason: reason,
    resolvedAt: new Date(),
    lastUsedAt: new Date(),
  }), `custom emoji asset failure ${customEmojiId}`);
  return { customEmojiId, mediaKey: null, failureReason: reason };
};

const readCachedAsset = async (customEmojiId: string): Promise<ResolvedCustomEmojiAsset | null> => {
  const asset = await CustomEmojiAsset.findByPk(customEmojiId);
  if (!asset) return null;

  if (asset.status === 'ready' && asset.previewMediaKey) {
    const media = await getCachedMedia(asset.previewMediaKey);
    if (media?.data && media.mime === 'image/png') {
      asset.lastUsedAt = new Date();
      await withBusyRetry(() => asset.save(), `custom emoji asset touch ${customEmojiId}`);
      return { customEmojiId, mediaKey: asset.previewMediaKey, failureReason: null };
    }
    return null;
  }

  const resolvedAt = asset.resolvedAt ? new Date(asset.resolvedAt).getTime() : 0;
  if (asset.status === 'failed' && Date.now() - resolvedAt < FAILED_ASSET_RETRY_MS) {
    return {
      customEmojiId,
      mediaKey: null,
      failureReason: asset.failureReason ?? 'custom emoji asset resolution failed',
    };
  }
  return null;
};

const createAssetPreview = async (
  bot: CustomEmojiBotClient,
  customEmojiId: string,
  sticker: Sticker,
  signal?: AbortSignal
): Promise<ResolvedCustomEmojiAsset> => {
  try {
    const downloaded = await withAbort(
      withPermit(
        telegramApiPool,
        () => downloadTelegramFile(bot, sticker.file_id, signal),
        signal
      ),
      signal
    );
    const sourceMime = sourceMimeOf(sticker, downloaded.sourcePath, downloaded.bytes);
    const preview = await createCustomEmojiPreview({
      data: downloaded.bytes,
      mimeType: sourceMime,
      animated: sticker.is_animated,
      video: sticker.is_video,
      needsRepainting: needsRepaintingOf(sticker),
    }, signal);
    signal?.throwIfAborted();
    if (!preview) {
      return saveFailedAsset(customEmojiId, 'failed to create a static custom emoji preview', sticker);
    }

    const repaintVariant = needsRepaintingOf(sticker) ? 'repaint' : 'original';
    const mediaKey = `custom-emoji-preview:${PREVIEW_VERSION}:${sticker.file_unique_id}:${repaintVariant}`;
    await withBusyRetry(() => putCachedMedia({
      fileUniqueId: mediaKey,
      data: preview.data,
      sizeBytes: preview.data.length,
      mime: preview.mimeType,
      kind: 'custom_emoji_preview',
    }), `custom emoji preview cache ${customEmojiId}`);
    await withBusyRetry(() => CustomEmojiAsset.upsert({
      customEmojiId,
      fileId: sticker.file_id,
      fileUniqueId: sticker.file_unique_id,
      kind: assetKindOf(sticker),
      sourceMime,
      previewMediaKey: mediaKey,
      fallbackEmoji: sticker.emoji ?? null,
      needsRepainting: needsRepaintingOf(sticker),
      status: 'ready',
      failureReason: null,
      resolvedAt: new Date(),
      lastUsedAt: new Date(),
    }), `custom emoji asset ready ${customEmojiId}`);
    return { customEmojiId, mediaKey, failureReason: null };
  } catch (error) {
    if (signal?.aborted) throw error;
    return saveFailedAsset(customEmojiId, failureText(error), sticker);
  }
};

const resolveOneAsset = (
  bot: CustomEmojiBotClient,
  customEmojiId: string,
  sticker: Sticker | undefined
): Promise<ResolvedCustomEmojiAsset> => {
  const existing = inFlightAssets.get(customEmojiId);
  if (existing) return existing;

  const resolution = (async (): Promise<ResolvedCustomEmojiAsset> => {
    const controller = createAcquisitionController(undefined, ASSET_TIMEOUT_MS);
    try {
      const cached = await withAbort(readCachedAsset(customEmojiId), controller.signal);
      if (cached) return cached;
      if (!sticker) return saveFailedAsset(customEmojiId, 'getCustomEmojiStickers returned no matching sticker');
      return await withPermit(
        previewPool,
        () => createAssetPreview(bot, customEmojiId, sticker, controller.signal),
        controller.signal
      );
    } finally {
      controller.dispose();
    }
  })().finally(() => {
    inFlightAssets.delete(customEmojiId);
  });
  inFlightAssets.set(customEmojiId, resolution);
  return resolution;
};

interface StickerFetchResult {
  stickersById: Map<string, Sticker>;
  failedIds: Set<string>;
}

const fetchStickerMap = async (
  bot: CustomEmojiBotClient,
  customEmojiIds: string[],
  signal?: AbortSignal
): Promise<StickerFetchResult> => {
  const stickersById = new Map<string, Sticker>();
  const failedIds = new Set<string>();
  for (const ids of chunk(customEmojiIds, CUSTOM_EMOJI_BATCH_SIZE)) {
    try {
      signal?.throwIfAborted();
      const stickers = await withAbort(
        withPermit(
          telegramApiPool,
          () => bot.api.getCustomEmojiStickers(ids, toTelegramApiAbortSignal(signal)),
          signal
        ),
        signal
      );
      for (const sticker of stickers) {
        if (sticker.custom_emoji_id) stickersById.set(sticker.custom_emoji_id, sticker);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      ids.forEach((customEmojiId) => failedIds.add(customEmojiId));
      console.error(
        `[custom-emoji] metadata lookup failed for ${ids.length} item(s):`,
        failureText(error)
      );
    }
  }
  return { stickersById, failedIds };
};

const markResolvedAttachment = async (
  revision: MessageRevisionToken,
  customEmojiId: string,
  resolved: ResolvedCustomEmojiAsset
): Promise<void> => {
  await withBusyRetry(() => markCustomEmojiAttachments({
    revision,
    customEmojiId,
    status: resolved.mediaKey ? 'ready' : 'failed',
    mediaKey: resolved.mediaKey,
    failureReason: resolved.failureReason,
  }), `custom emoji attachment ${revision.chatId}/${revision.messageId}/${customEmojiId}`);
};

const doAcquireCustomEmojiAttachments = async (
  bot: CustomEmojiBotClient,
  revision: MessageRevisionToken,
  signal?: AbortSignal
): Promise<void> => {
  const attachments = await withAbort(
    getPendingCustomEmojiAttachments(revision),
    signal
  );
  const customEmojiIds = [...new Set(attachments.map((attachment) => attachment.customEmojiId))];
  if (customEmojiIds.length === 0) return;

  const cachedById = new Map<string, ResolvedCustomEmojiAsset>();
  const unresolvedIds: string[] = [];
  for (const customEmojiId of customEmojiIds) {
    signal?.throwIfAborted();
    const cached = await withAbort(readCachedAsset(customEmojiId), signal);
    if (cached) cachedById.set(customEmojiId, cached);
    else unresolvedIds.push(customEmojiId);
  }
  const fetched = unresolvedIds.length > 0
    ? await fetchStickerMap(bot, unresolvedIds, signal)
    : { stickersById: new Map<string, Sticker>(), failedIds: new Set<string>() };

  const results = await Promise.allSettled(customEmojiIds.map(async (customEmojiId) => {
    signal?.throwIfAborted();
    if (fetched.failedIds.has(customEmojiId)) {
      await withBusyRetry(() => markCustomEmojiAttachments({
        revision,
        customEmojiId,
        status: 'failed',
        failureReason: 'custom emoji metadata lookup failed; retry on the next occurrence',
      }), `custom emoji metadata failure ${revision.chatId}/${revision.messageId}/${customEmojiId}`);
      return;
    }
    const resolved = cachedById.get(customEmojiId)
      ?? await withAbort(
        resolveOneAsset(bot, customEmojiId, fetched.stickersById.get(customEmojiId)),
        signal
      );
    await markResolvedAttachment(revision, customEmojiId, resolved);
  }));

  for (const result of results) {
    if (result.status === 'rejected') {
      console.error(
        `[custom-emoji] item failed for ${revision.chatId}/${revision.messageId}:`,
        failureText(result.reason)
      );
    }
  }
};

const settleRemainingPending = async (
  revision: MessageRevisionToken,
  failureReason: string
): Promise<void> => {
  try {
    await withBusyRetry(
      () => failPendingCustomEmojiAttachments(revision, failureReason),
      `custom emoji finalization ${revision.chatId}/${revision.messageId}`
    );
  } catch (error) {
    console.error(
      `[custom-emoji] could not settle pending rows for ${revision.chatId}/${revision.messageId}:`,
      failureText(error)
    );
  }
};

const revisionKey = (revision: MessageRevisionToken): string =>
  `${revision.chatId}:${revision.messageId}:${revision.telegramTimestamp}:${revision.updateId}`;

/** Resolve every selected emoji and always converge remaining rows out of pending. */
export const acquireCustomEmojiAttachments = (
  bot: CustomEmojiBotClient,
  revision: MessageRevisionToken,
  signal?: AbortSignal
): Promise<void> => {
  const key = revisionKey(revision);
  const existing = inFlightRevisions.get(key);
  if (existing) return existing;

  const acquisition = (async (): Promise<void> => {
    const controller = createAcquisitionController(signal);
    let failureReason = 'custom emoji acquisition ended before every item settled';
    try {
      await withPermit(
        acquisitionPool,
        () => doAcquireCustomEmojiAttachments(bot, revision, controller.signal),
        controller.signal
      );
    } catch (error) {
      failureReason = `custom emoji acquisition failed: ${failureText(error)}`;
      console.error(`[custom-emoji] ${revision.chatId}/${revision.messageId}:`, failureText(error));
    } finally {
      controller.dispose();
      await settleRemainingPending(revision, failureReason);
    }
  })().finally(() => {
    inFlightRevisions.delete(key);
  });
  inFlightRevisions.set(key, acquisition);
  return acquisition;
};

/** Recover current pending manifests left behind by a previous process. */
export const recoverPendingCustomEmojiAttachments = async (
  bot: CustomEmojiBotClient
): Promise<void> => {
  await withBusyRetry(
    () => failOrphanedPendingCustomEmojiAttachments(),
    'custom emoji orphan cleanup'
  );
  const revisions = await getRecoverableCustomEmojiRevisions(RECOVERY_BATCH_SIZE);
  if (revisions.length === 0) return;
  console.log(`[custom-emoji] recovering ${revisions.length} pending message revision(s)`);
  await Promise.all(revisions.map((revision) => acquireCustomEmojiAttachments(bot, revision)));
};

let recoveryRunning = false;

const runRecoveryPass = async (bot: CustomEmojiBotClient): Promise<void> => {
  if (recoveryRunning) return;
  recoveryRunning = true;
  try {
    await recoverPendingCustomEmojiAttachments(bot);
  } catch (error) {
    console.error('[custom-emoji] recovery pass failed:', failureText(error));
  } finally {
    recoveryRunning = false;
  }
};

/** Start bounded background recovery for persisted pending manifests. */
export const startCustomEmojiRecovery = (bot: CustomEmojiBotClient): void => {
  if (process.env.CUSTOM_EMOJI_ENABLED === '0') return;
  void runRecoveryPass(bot);
  const timer = setInterval(() => void runRecoveryPass(bot), RECOVERY_INTERVAL_MS);
  timer.unref();
};

/** Build or reuse one labeled PNG atlas from ready emoji previews. */
export const getOrCreateCustomEmojiAtlas = async (
  sources: readonly CustomEmojiAtlasSource[],
  signal?: AbortSignal
): Promise<{ data: Buffer; mediaKey: string } | null> => {
  if (sources.length === 0 || sources.length > 8) return null;
  const digest = createHash('sha256')
    .update(ATLAS_VERSION)
    .update('\0')
    .update(sources.map((source) => `${source.label}:${source.mediaKey}`).join('\0'))
    .digest('hex');
  const mediaKey = `custom-emoji-atlas:${ATLAS_VERSION}:${digest}`;
  const cached = await getCachedMedia(mediaKey);
  if (cached?.data && cached.mime === 'image/png') {
    return { data: cached.data, mediaKey };
  }

  const items: CustomEmojiAtlasItem[] = [];
  for (const source of sources) {
    signal?.throwIfAborted();
    const media = await getCachedMedia(source.mediaKey);
    if (!media?.data || media.mime !== 'image/png') return null;
    items.push({ label: source.label, image: media.data });
  }
  const atlas = await createCustomEmojiAtlas(items, signal);
  if (!atlas) return null;
  await withBusyRetry(() => putCachedMedia({
    fileUniqueId: mediaKey,
    data: atlas.data,
    sizeBytes: atlas.data.length,
    mime: atlas.mimeType,
    kind: 'custom_emoji_atlas',
  }), `custom emoji atlas cache ${digest.slice(0, 12)}`);
  return { data: atlas.data, mediaKey };
};
