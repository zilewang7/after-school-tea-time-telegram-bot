import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageEntity, Sticker } from 'grammy/types';
import {
  OFFLINE_CHAT_ID,
  expect,
  reportResults,
  runCase,
  setupOfflineDb,
  takeMessageId,
  type CaseResult,
} from './harness.mts';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
  'base64'
);

let previewRequests = 0;
let atlasRequests = 0;
let activePreviewRequests = 0;
let maxActivePreviewRequests = 0;
let previewResponseDelayMs = 0;
let atlasResponseDelayMs = 0;
const sendPng = (response: import('node:http').ServerResponse): void => {
  if (response.destroyed) return;
  response.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': PNG_BYTES.length,
  });
  response.end(PNG_BYTES);
};
const converter = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    if (request.url?.startsWith('/emoji-preview')) {
      previewRequests += 1;
      activePreviewRequests += 1;
      maxActivePreviewRequests = Math.max(maxActivePreviewRequests, activePreviewRequests);
      setTimeout(() => {
        activePreviewRequests -= 1;
        sendPng(response);
      }, previewResponseDelayMs);
      return;
    }
    if (request.url === '/emoji-atlas') {
      atlasRequests += 1;
      setTimeout(() => sendPng(response), atlasResponseDelayMs);
      return;
    }
    response.writeHead(404);
    response.end();
  });
});
await new Promise<void>((resolve) => converter.listen(0, '127.0.0.1', resolve));
const address = converter.address();
if (!address || typeof address === 'string') throw new Error('converter stub did not bind TCP');
process.env.TGS_CONVERTER_URL = `http://127.0.0.1:${address.port}`;
process.env.CUSTOM_EMOJI_ENABLED = '1';
process.env.CUSTOM_EMOJI_CONTEXT_TIMEOUT_MS = '100';
process.env.CUSTOM_EMOJI_ACQUISITION_TIMEOUT_MS = '1000';

const tempDirectory = await mkdtemp(join(tmpdir(), 'custom-emoji-offline-'));
const emojiFileA = join(tempDirectory, 'emoji-a.bin');
const emojiFileB = join(tempDirectory, 'emoji-b.bin');
await Promise.all([
  writeFile(emojiFileA, PNG_BYTES),
  writeFile(emojiFileB, PNG_BYTES),
]);

const db = await setupOfflineDb();
const { Message, putCachedMedia } = db;
const { sequelize } = await import('../../src/db/config.js');
const { MessageAttachment } = await import('../../src/db/messageAttachmentDTO.js');
const { CustomEmojiAsset } = await import('../../src/db/customEmojiAssetDTO.js');
const { LinkPreviewCache } = await import('../../src/db/linkPreviewCacheDTO.js');
const { runSchemaMigrations } = await import('../../src/db/schema-migrations.js');
const { extractCustomEmojiOccurrences } = await import('../../src/services/custom-emoji-extractor.js');
const {
  replaceCustomEmojiAttachments,
  getCustomEmojiAttachmentsForMessages,
  failPendingCustomEmojiAttachments,
  markCustomEmojiAttachments,
} = await import('../../src/db/queries/message-attachment-queries.js');
const {
  claimMessageRevision,
  updateLinkPreviewOcrForRevision,
  updateMessageMediaForRevision,
  updateMessageOcrForRevision,
} = await import('../../src/db/queries/message-revision-queries.js');
const {
  acquireCustomEmojiAttachments,
  recoverPendingCustomEmojiAttachments,
} = await import('../../src/services/custom-emoji-service.js');
type CustomEmojiBotClient = import('../../src/services/custom-emoji-service.js').CustomEmojiBotClient;
const { buildCustomEmojiContextPlan } = await import('../../src/services/custom-emoji-context-service.js');
const {
  addAsyncFileSaveTask,
  removeAsyncFileSaveTask,
  retainAsyncFileSaveTasks,
  isAsyncFileSavePending,
  addAsyncPreviewTask,
  removeAsyncPreviewTask,
  isAsyncPreviewPending,
  addAsyncOcrTask,
  removeAsyncOcrTask,
  isAsyncOcrPending,
} = await import('../../src/state.js');
const { toVisionImageMimeType } = await import('../../src/ai/supported-mime.js');
const { transformToAnthropic } = await import('../../src/ai/message-transformer.js');

const seedMessage = async (messageId: number, text: string): Promise<void> => {
  await Message.create({
    chatId: OFFLINE_CHAT_ID,
    messageId,
    fromBotSelf: false,
    userId: 1001,
    date: new Date(),
    userName: 'tester',
    text,
    quoteText: null,
    file: null,
    fileMime: null,
    fileUniqueId: null,
    replyToId: null,
    chatCommand: null,
    modelParts: null,
    mediaHint: null,
    forwardOrigin: null,
    forwardFromId: null,
    viaBot: null,
    ocrText: null,
  });
};

type RevisionToken = import('../../src/db/queries/message-revision-queries.js').MessageRevisionToken;

const revisionOf = (
  messageId: number,
  updateId: number,
  telegramTimestamp = updateId
): RevisionToken => ({
  chatId: OFFLINE_CHAT_ID,
  messageId,
  updateId,
  telegramTimestamp,
});

const claimRevisionForTest = async (revision: RevisionToken): Promise<void> => {
  const accepted = await sequelize.transaction((transaction) =>
    claimMessageRevision(revision, transaction)
  );
  expect(accepted, `revision ${revision.updateId} is accepted`);
};

const customEntity = (
  offset: number,
  length: number,
  customEmojiId: string
): MessageEntity => ({
  type: 'custom_emoji',
  offset,
  length,
  custom_emoji_id: customEmojiId,
});

const sticker = (customEmojiId: string, fileId: string): Sticker => ({
  type: 'custom_emoji',
  width: 100,
  height: 100,
  is_animated: false,
  is_video: false,
  file_id: fileId,
  file_unique_id: `unique-${customEmojiId}`,
  custom_emoji_id: customEmojiId,
  emoji: '🙂',
});

let metadataRequests = 0;
let fileRequests = 0;
const emojiPaths = new Map<string, string>([
  ['file-a', emojiFileA],
  ['file-b', emojiFileB],
]);
const botClient: CustomEmojiBotClient = {
  api: {
    getCustomEmojiStickers: async (customEmojiIds) => {
      metadataRequests += 1;
      return customEmojiIds
        .map((customEmojiId) => sticker(customEmojiId, `file-${customEmojiId.slice(-1)}`))
        .reverse();
    },
    getFile: async (fileId) => {
      fileRequests += 1;
      return { file_path: emojiPaths.get(fileId) };
    },
  },
};

const cases: Array<{ name: string; body: () => Promise<void> }> = [
  {
    name: 'custom emoji extraction preserves UTF-16 order and fallback text',
    body: async () => {
      const text = 'A😀x🙂B';
      const occurrences = extractCustomEmojiOccurrences({
        text,
        entities: [customEntity(4, 2, 'b'), customEntity(1, 2, 'a')],
      });
      expect(occurrences.map((item) => item.customEmojiId).join(',') === 'a,b', 'entities are sorted by UTF-16 offset');
      expect(occurrences[0]?.fallbackText === '😀', 'surrogate-pair fallback is sliced correctly');
      expect(occurrences[1]?.fallbackText === '🙂', 'the second fallback is preserved');

      const caption = extractCustomEmojiOccurrences({
        caption: 'x🙂',
        caption_entities: [customEntity(1, 2, 'caption-id')],
      });
      expect(caption[0]?.source === 'caption', 'caption entities are extracted');

      const rich = extractCustomEmojiOccurrences({
        rich_message: {
          blocks: [{
            type: 'paragraph',
            text: ['before', { type: 'custom_emoji', custom_emoji_id: 'rich-id', alternative_text: '🔥' }],
          }],
        },
      });
      expect(rich[0]?.customEmojiId === 'rich-id' && rich[0].fallbackText === '🔥', 'rich text custom emoji is extracted');
    },
  },
  {
    name: 'attachment manifest keeps occurrences and caps unique visuals',
    body: async () => {
      const messageId = takeMessageId();
      await seedMessage(messageId, 'budget');
      await replaceCustomEmojiAttachments(
        revisionOf(messageId, 100),
        Array.from({ length: 10 }, (_, ordinal) => ({
          ordinal,
          source: 'text',
          customEmojiId: `budget-${ordinal}`,
          offsetUtf16: ordinal,
          lengthUtf16: 1,
          fallbackText: '🙂',
        }))
      );
      const rows = await MessageAttachment.findAll({
        where: { chatId: OFFLINE_CHAT_ID, messageId },
        order: [['ordinal', 'ASC']],
      });
      expect(rows.length === 10, 'all occurrences remain represented');
      expect(rows.filter((row) => row.status === 'pending').length === 8, 'only eight unique visuals are selected');
      expect(rows.filter((row) => row.status === 'omitted').length === 2, 'overflow visuals degrade explicitly');
    },
  },
  {
    name: 'custom emoji assets resolve by id, cache, and build a labeled atlas',
    body: async () => {
      const firstMessageId = takeMessageId();
      await seedMessage(firstMessageId, 'first 🙂🙂🔥');
      const occurrences = [
        { ordinal: 0, source: 'text' as const, customEmojiId: 'a', offsetUtf16: 6, lengthUtf16: 2, fallbackText: '🙂' },
        { ordinal: 1, source: 'text' as const, customEmojiId: 'a', offsetUtf16: 8, lengthUtf16: 2, fallbackText: '🙂' },
        { ordinal: 2, source: 'text' as const, customEmojiId: 'b', offsetUtf16: 10, lengthUtf16: 2, fallbackText: '🔥' },
      ];
      const firstRevision = revisionOf(firstMessageId, 200);
      await claimRevisionForTest(firstRevision);
      await replaceCustomEmojiAttachments(firstRevision, occurrences);
      await acquireCustomEmojiAttachments(botClient, firstRevision);
      const firstRows = (await getCustomEmojiAttachmentsForMessages(
        OFFLINE_CHAT_ID,
        [firstMessageId]
      )).get(firstMessageId) ?? [];
      expect(firstRows.every((row) => row.status === 'ready' && Boolean(row.mediaKey)), 'every occurrence points at a ready preview');
      expect(metadataRequests === 1, 'unique ids are resolved in one metadata batch');
      expect(fileRequests === 2 && previewRequests === 2, 'duplicate occurrences download and render once per id');

      const secondMessageId = takeMessageId();
      await seedMessage(secondMessageId, 'again 🙂🔥');
      const secondRevision = revisionOf(secondMessageId, 201);
      await claimRevisionForTest(secondRevision);
      await replaceCustomEmojiAttachments(secondRevision, [
        { ...occurrences[0]!, ordinal: 0 },
        { ...occurrences[2]!, ordinal: 1 },
      ]);
      await acquireCustomEmojiAttachments(botClient, secondRevision);
      expect(metadataRequests === 1 && fileRequests === 2 && previewRequests === 2, 'a repeated emoji uses metadata and preview caches');

      const visual = await buildCustomEmojiContextPlan(
        OFFLINE_CHAT_ID,
        [firstMessageId, secondMessageId],
        true
      );
      expect(visual.atlasParts.length === 1 && visual.atlasParts[0]?.mimeType === 'image/png', 'ready previews become one PNG atlas');
      expect(atlasRequests === 1, 'the atlas is rendered once');
      expect(visual.annotations.get(firstMessageId)?.includes('E1 replaces fallback'), 'history receives an E# occurrence legend');
      expect(visual.annotations.get(secondMessageId)?.includes('labeled custom-emoji atlas'), 'current message points at the atlas');

      const textOnly = await buildCustomEmojiContextPlan(
        OFFLINE_CHAT_ID,
        [firstMessageId, secondMessageId],
        false
      );
      expect(textOnly.atlasParts.length === 0, 'a text-only model receives no image');
      expect(textOnly.annotations.get(secondMessageId)?.includes('visual unavailable'), 'text-only fallback is explicit');
      expect(atlasRequests === 1, 'text-only context does not call the atlas renderer');

      const assets = await CustomEmojiAsset.findAll();
      expect(assets.length === 2, 'one asset metadata row is stored per custom emoji id');
    },
  },
  {
    name: 'custom emoji preview work respects the global concurrency limit',
    body: async () => {
      const messageId = takeMessageId();
      await seedMessage(messageId, 'concurrency');
      const customEmojiIds = Array.from({ length: 8 }, (_, index) => `concurrency-${index}`);
      const revision = revisionOf(messageId, 250);
      await claimRevisionForTest(revision);
      await replaceCustomEmojiAttachments(
        revision,
        customEmojiIds.map((customEmojiId, ordinal) => ({
          ordinal,
          source: 'text' as const,
          customEmojiId,
          offsetUtf16: ordinal,
          lengthUtf16: 1,
          fallbackText: '🙂',
        }))
      );
      const concurrencyBot: CustomEmojiBotClient = {
        api: {
          getCustomEmojiStickers: async (ids) => ids.map((customEmojiId) =>
            sticker(customEmojiId, `file-${customEmojiId}`)
          ),
          getFile: async () => ({ file_path: emojiFileA }),
        },
      };
      maxActivePreviewRequests = 0;
      previewResponseDelayMs = 30;
      try {
        await acquireCustomEmojiAttachments(concurrencyBot, revision);
      } finally {
        previewResponseDelayMs = 0;
      }
      expect(maxActivePreviewRequests === 3, 'no more than three previews run concurrently');
    },
  },
  {
    name: 'message revisions reject stale edits and stale media workers',
    body: async () => {
      const messageId = takeMessageId();
      await seedMessage(messageId, 'initial');
      await Message.update(
        {
          file: PNG_BYTES,
          fileMime: 'image/png',
          fileUniqueId: 'old-media',
          mediaHint: 'old picture',
          ocrText: 'old OCR',
        },
        { where: { chatId: OFFLINE_CHAT_ID, messageId } }
      );
      const first = { chatId: OFFLINE_CHAT_ID, messageId, updateId: 300, telegramTimestamp: 1000 };
      const newer = { chatId: OFFLINE_CHAT_ID, messageId, updateId: 301, telegramTimestamp: 1000 };

      const firstAccepted = await sequelize.transaction(async (transaction) => {
        const accepted = await claimMessageRevision(first, transaction);
        if (accepted) await Message.update({ text: 'first edit' }, { where: { chatId: OFFLINE_CHAT_ID, messageId }, transaction });
        return accepted;
      });
      const newerAccepted = await sequelize.transaction(async (transaction) => {
        const accepted = await claimMessageRevision(newer, transaction);
        if (accepted) {
          await Message.update(
            {
              text: 'newest edit',
              file: null,
              fileMime: null,
              fileUniqueId: null,
              mediaHint: 'new picture',
              ocrText: null,
            },
            { where: { chatId: OFFLINE_CHAT_ID, messageId }, transaction }
          );
        }
        return accepted;
      });
      const clearedRow = await Message.findOne({ where: { chatId: OFFLINE_CHAT_ID, messageId } });
      const staleAccepted = await sequelize.transaction((transaction) =>
        claimMessageRevision(first, transaction)
      );
      const staleMediaUpdated = await updateMessageMediaForRevision(first, {
        fileMime: 'image/png',
        fileUniqueId: 'stale-media',
        mediaHint: 'stale',
      });
      const failureHintUpdated = await updateMessageMediaForRevision(newer, {
        mediaHint: 'new picture — failed to download, you cannot see it',
      });
      const failedRow = await Message.findOne({ where: { chatId: OFFLINE_CHAT_ID, messageId } });
      const freshMediaUpdated = await updateMessageMediaForRevision(newer, {
        fileMime: 'image/png',
        fileUniqueId: 'fresh-media',
        mediaHint: 'fresh',
      });
      const row = await Message.findOne({ where: { chatId: OFFLINE_CHAT_ID, messageId } });
      expect(firstAccepted && newerAccepted && !staleAccepted, 'only monotonically newer update ids are accepted');
      expect(
        clearedRow?.file === null
          && clearedRow.fileUniqueId === null
          && clearedRow.ocrText === null,
        'a replacement media revision clears stale bytes and OCR before acquisition'
      );
      expect(
        failureHintUpdated
          && failedRow?.fileUniqueId === null
          && failedRow.mediaHint?.includes('failed to download'),
        'a replacement media failure cannot expose the old image'
      );
      expect(!staleMediaUpdated && freshMediaUpdated, 'only the current revision may write media');
      expect(row?.text === 'newest edit' && row.fileUniqueId === 'fresh-media', 'stale work cannot restore old content or media');
    },
  },
  {
    name: 'later timestamps win even when update ids decrease and OCR uses SQL CAS',
    body: async () => {
      const messageId = takeMessageId();
      await seedMessage(messageId, 'revision ordering');
      const earlier = revisionOf(messageId, 900, 5000);
      const later = revisionOf(messageId, 1, 5001);
      const previewUrl = `https://example.test/revision-${messageId}`;
      await LinkPreviewCache.create({
        url: previewUrl,
        status: 'ready',
        lastUsedAt: new Date(),
      });

      await claimRevisionForTest(earlier);
      expect(
        await updateMessageOcrForRevision(earlier, 'earlier OCR'),
        'current message revision stores OCR'
      );
      expect(
        await updateLinkPreviewOcrForRevision(earlier, previewUrl, 'earlier preview OCR'),
        'current message revision stores preview OCR'
      );
      await claimRevisionForTest(later);

      expect(
        !(await updateMessageOcrForRevision(earlier, 'stale OCR')),
        'an old worker cannot update message OCR after a newer claim'
      );
      expect(
        !(await updateLinkPreviewOcrForRevision(earlier, previewUrl, 'stale preview OCR')),
        'an old worker cannot update URL-scoped preview OCR'
      );
      expect(
        await updateMessageOcrForRevision(later, null),
        'a current OCR result with no text clears the previous value'
      );
      expect(
        await updateLinkPreviewOcrForRevision(later, previewUrl, 'latest preview OCR'),
        'a later timestamp with a smaller update id wins preview OCR ordering'
      );

      const row = await Message.findOne({ where: { chatId: OFFLINE_CHAT_ID, messageId } });
      const preview = await LinkPreviewCache.findByPk(previewUrl);
      expect(row?.ocrText === null, 'stale message OCR is not retained');
      expect(
        preview?.ocrText === 'latest preview OCR'
          && preview.ocrSourceTimestamp === later.telegramTimestamp
          && preview.ocrSourceUpdateId === later.updateId,
        'preview OCR records the winning revision'
      );
    },
  },
  {
    name: 'pending emoji acquisition times out and converges to failed',
    body: async () => {
      const messageId = takeMessageId();
      await seedMessage(messageId, 'hung emoji');
      const revision = revisionOf(messageId, 350);
      await claimRevisionForTest(revision);
      await replaceCustomEmojiAttachments(revision, [{
        ordinal: 0,
        source: 'text',
        customEmojiId: `hung-${messageId}`,
        offsetUtf16: 0,
        lengthUtf16: 1,
        fallbackText: '🙂',
      }]);
      const hungBot: CustomEmojiBotClient = {
        api: {
          getCustomEmojiStickers: async () => new Promise<Sticker[]>(() => undefined),
          getFile: async () => ({ file_path: emojiFileA }),
        },
      };

      const startedAt = Date.now();
      await acquireCustomEmojiAttachments(hungBot, revision);
      const elapsedMs = Date.now() - startedAt;
      const rows = (await getCustomEmojiAttachmentsForMessages(
        OFFLINE_CHAT_ID,
        [messageId]
      )).get(messageId) ?? [];
      expect(elapsedMs < 2500, 'a hung metadata request is released by the acquisition deadline');
      expect(
        rows.length === 1 && rows[0]?.status === 'failed',
        'deadline finalization leaves no attachment permanently pending'
      );
    },
  },
  {
    name: 'acquisition deadline aborts the underlying Telegram getFile request',
    body: async () => {
      const messageId = takeMessageId();
      await seedMessage(messageId, 'hung getFile');
      const revision = revisionOf(messageId, 355);
      const customEmojiId = `hung-file-${messageId}`;
      await claimRevisionForTest(revision);
      await replaceCustomEmojiAttachments(revision, [{
        ordinal: 0,
        source: 'text',
        customEmojiId,
        offsetUtf16: 0,
        lengthUtf16: 1,
        fallbackText: '🙂',
      }]);
      let getFileStarted = false;
      let signalReceived = false;
      let abortObserved = false;
      const hungFileBot: CustomEmojiBotClient = {
        api: {
          getCustomEmojiStickers: async () => [sticker(customEmojiId, `file-${customEmojiId}`)],
          getFile: async (_fileId, signal) => new Promise((_resolve, reject) => {
            getFileStarted = true;
            signalReceived = signal !== undefined;
            const onAbort = (): void => {
              abortObserved = true;
              reject(new Error('getFile aborted'));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) onAbort();
          }),
        },
      };

      await acquireCustomEmojiAttachments(hungFileBot, revision);
      const abortDeadline = Date.now() + 500;
      while (!abortObserved && Date.now() < abortDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const rows = (await getCustomEmojiAttachmentsForMessages(
        OFFLINE_CHAT_ID,
        [messageId]
      )).get(messageId) ?? [];
      expect(getFileStarted, 'the asset worker starts grammY getFile');
      expect(signalReceived, 'grammY getFile receives an abort signal');
      expect(abortObserved, 'the shared asset deadline reaches grammY getFile');
      expect(rows[0]?.status === 'failed', 'an aborted getFile settles the attachment');
    },
  },
  {
    name: 'startup recovery resolves current pending rows and fails orphaned revisions',
    body: async () => {
      const currentMessageId = takeMessageId();
      await seedMessage(currentMessageId, 'recover current');
      const currentRevision = revisionOf(currentMessageId, 360);
      await claimRevisionForTest(currentRevision);
      await replaceCustomEmojiAttachments(currentRevision, [{
        ordinal: 0,
        source: 'text',
        customEmojiId: `recovery-${currentMessageId}`,
        offsetUtf16: 0,
        lengthUtf16: 1,
        fallbackText: '🙂',
      }]);

      const orphanMessageId = takeMessageId();
      await seedMessage(orphanMessageId, 'recover orphan');
      const orphanRevision = revisionOf(orphanMessageId, 361, 6000);
      await claimRevisionForTest(orphanRevision);
      await replaceCustomEmojiAttachments(orphanRevision, [{
        ordinal: 0,
        source: 'text',
        customEmojiId: `orphan-${orphanMessageId}`,
        offsetUtf16: 0,
        lengthUtf16: 1,
        fallbackText: '🙂',
      }]);
      await claimRevisionForTest(revisionOf(orphanMessageId, 1, 6001));

      const recoveryBot: CustomEmojiBotClient = {
        api: {
          getCustomEmojiStickers: async (ids) => ids.map((customEmojiId) =>
            sticker(customEmojiId, `file-${customEmojiId}`)
          ),
          getFile: async () => ({ file_path: emojiFileA }),
        },
      };
      await recoverPendingCustomEmojiAttachments(recoveryBot);

      const currentRows = (await getCustomEmojiAttachmentsForMessages(
        OFFLINE_CHAT_ID,
        [currentMessageId]
      )).get(currentMessageId) ?? [];
      const orphanRows = (await getCustomEmojiAttachmentsForMessages(
        OFFLINE_CHAT_ID,
        [orphanMessageId]
      )).get(orphanMessageId) ?? [];
      expect(currentRows[0]?.status === 'ready', 'startup recovery resumes the current pending revision');
      expect(
        orphanRows[0]?.status === 'failed'
          && orphanRows[0].failureReason?.includes('no longer current'),
        'startup recovery fails pending rows from an obsolete revision'
      );
    },
  },
  {
    name: 'atlas timeout fails open with fallback annotations',
    body: async () => {
      const messageId = takeMessageId();
      await seedMessage(messageId, 'atlas timeout 🙂');
      const revision = revisionOf(messageId, 370);
      await claimRevisionForTest(revision);
      const mediaKey = `timeout-preview-${messageId}`;
      await putCachedMedia({
        fileUniqueId: mediaKey,
        data: PNG_BYTES,
        sizeBytes: PNG_BYTES.length,
        mime: 'image/png',
        kind: 'custom_emoji_preview',
      });
      await replaceCustomEmojiAttachments(revision, [{
        ordinal: 0,
        source: 'text',
        customEmojiId: `timeout-${messageId}`,
        offsetUtf16: 14,
        lengthUtf16: 2,
        fallbackText: '🙂',
      }]);
      await markCustomEmojiAttachments({
        revision,
        customEmojiId: `timeout-${messageId}`,
        status: 'ready',
        mediaKey,
      });

      atlasResponseDelayMs = 300;
      const startedAt = Date.now();
      try {
        const plan = await buildCustomEmojiContextPlan(OFFLINE_CHAT_ID, [messageId], true);
        const elapsedMs = Date.now() - startedAt;
        expect(elapsedMs < 500, 'atlas generation obeys the short total context deadline');
        expect(plan.atlasParts.length === 0, 'a timed-out atlas is omitted');
        expect(
          plan.annotations.get(messageId)?.includes('visual omitted'),
          'fallback annotation remains when the atlas service is unavailable'
        );
      } finally {
        atlasResponseDelayMs = 0;
      }
    },
  },
  {
    name: 'custom emoji schema migrations are idempotent',
    body: async () => {
      await runSchemaMigrations();
      await runSchemaMigrations();
      const [attachmentColumns] = await sequelize.query('PRAGMA table_info(message_attachments)');
      const [previewColumns] = await sequelize.query('PRAGMA table_info(link_preview_cache)');
      const [migrationRows] = await sequelize.query(
        "SELECT name FROM schema_migrations WHERE name = '20260908_custom_emoji_phase1'"
      );
      const hasColumn = (rows: unknown[], name: string): boolean => rows.some((row) =>
        typeof row === 'object'
          && row !== null
          && 'name' in row
          && row.name === name
      );
      expect(
        hasColumn(attachmentColumns, 'sourceTimestamp'),
        'attachment revision timestamp column exists after repeated migration'
      );
      expect(
        hasColumn(previewColumns, 'ocrSourceTimestamp')
          && hasColumn(previewColumns, 'ocrSourceUpdateId'),
        'preview OCR revision columns exist after repeated migration'
      );
      expect(migrationRows.length === 1, 'migration ledger contains one idempotent entry');
    },
  },
  {
    name: 'file task registry waits for every task and isolates chats',
    body: async () => {
      const messageId = 42;
      const otherChat = OFFLINE_CHAT_ID - 1;
      addAsyncFileSaveTask(OFFLINE_CHAT_ID, messageId, 'primary');
      addAsyncFileSaveTask(OFFLINE_CHAT_ID, messageId, 'emoji');
      addAsyncFileSaveTask(otherChat, messageId, 'other');
      removeAsyncFileSaveTask(OFFLINE_CHAT_ID, messageId, 'primary');
      expect(isAsyncFileSavePending(OFFLINE_CHAT_ID, messageId), 'one completed task does not release its sibling');
      expect(isAsyncFileSavePending(otherChat, messageId), 'the same message id in another chat is independent');
      const currentTask = 'custom-emoji:1:1000:500';
      const newerTask = 'custom-emoji:2:1001:1';
      addAsyncFileSaveTask(OFFLINE_CHAT_ID, messageId, currentTask);
      addAsyncFileSaveTask(OFFLINE_CHAT_ID, messageId, newerTask);
      retainAsyncFileSaveTasks(
        OFFLINE_CHAT_ID,
        messageId,
        { updateId: 500, telegramTimestamp: 1000 },
        [currentTask]
      );
      removeAsyncFileSaveTask(OFFLINE_CHAT_ID, messageId, currentTask);
      expect(isAsyncFileSavePending(OFFLINE_CHAT_ID, messageId), 'task pruning preserves a later timestamp with a smaller update id');
      removeAsyncFileSaveTask(OFFLINE_CHAT_ID, messageId, newerTask);
      removeAsyncFileSaveTask(otherChat, messageId, 'other');
      expect(!isAsyncFileSavePending(OFFLINE_CHAT_ID, messageId), 'the message settles after its final task');

      addAsyncPreviewTask(OFFLINE_CHAT_ID, messageId, currentTask);
      addAsyncPreviewTask(otherChat, messageId, newerTask);
      removeAsyncPreviewTask(OFFLINE_CHAT_ID, messageId, currentTask);
      expect(!isAsyncPreviewPending(OFFLINE_CHAT_ID, messageId), 'preview completion is isolated by chat and task');
      expect(isAsyncPreviewPending(otherChat, messageId), 'another chat preview remains pending');
      removeAsyncPreviewTask(otherChat, messageId, newerTask);

      addAsyncOcrTask(OFFLINE_CHAT_ID, messageId, currentTask);
      addAsyncOcrTask(OFFLINE_CHAT_ID, messageId, newerTask);
      removeAsyncOcrTask(OFFLINE_CHAT_ID, messageId, currentTask);
      expect(isAsyncOcrPending(OFFLINE_CHAT_ID, messageId), 'one OCR revision cannot release another');
      removeAsyncOcrTask(OFFLINE_CHAT_ID, messageId, newerTask);
      expect(!isAsyncOcrPending(OFFLINE_CHAT_ID, messageId), 'OCR settles after its final task');
    },
  },
  {
    name: 'vision MIME handling preserves supported types and rejects false labels',
    body: async () => {
      expect(toVisionImageMimeType('image/jpg') === 'image/jpeg', 'the JPEG alias is normalized');
      expect(toVisionImageMimeType('image/webp') === 'image/webp', 'WebP remains WebP');
      expect(toVisionImageMimeType('image/heic') === null, 'unsupported HEIC is not relabeled as PNG');

      const anthropic = transformToAnthropic([{
        role: 'user',
        content: [
          { type: 'image', imageData: 'webp', mimeType: 'image/webp' },
          { type: 'image', imageData: 'heic', mimeType: 'image/heic' },
        ],
      }]);
      const content = anthropic[0]?.content;
      expect(Array.isArray(content) && content[0]?.type === 'image' && content[0].source.media_type === 'image/webp', 'Anthropic receives the real WebP MIME');
      expect(Array.isArray(content) && content[1]?.type === 'text', 'unsupported image bytes become a text fallback');
    },
  },
  {
    name: 'custom emoji atlas coexists with the message primary image',
    body: async () => {
      const messageId = takeMessageId();
      await seedMessage(messageId, 'look 🙂');
      await putCachedMedia({
        fileUniqueId: 'primary-image',
        data: PNG_BYTES,
        sizeBytes: PNG_BYTES.length,
        mime: 'image/png',
        kind: 'photo',
      });
      await Message.update(
        { fileUniqueId: 'primary-image', fileMime: 'image/png', mediaHint: 'a picture' },
        { where: { chatId: OFFLINE_CHAT_ID, messageId } }
      );
      const revision = revisionOf(messageId, 400);
      await claimRevisionForTest(revision);
      await replaceCustomEmojiAttachments(revision, [{
        ordinal: 0,
        source: 'text',
        customEmojiId: 'a',
        offsetUtf16: 5,
        lengthUtf16: 2,
        fallbackText: '🙂',
      }]);
      await acquireCustomEmojiAttachments(botClient, revision);
      const row = await Message.findOne({ where: { chatId: OFFLINE_CHAT_ID, messageId } });
      if (!row) throw new Error('seeded message disappeared');
      const { buildContext } = await import('../../src/reply/context-builder.js');
      const built = await buildContext(row, {
        supportsImageInput: true,
        supportsImageOutput: false,
        supportsSystemPrompt: true,
        requiresMessageMerge: false,
        supportsThinking: false,
        supportsGrounding: false,
        supportsMediaInput: false,
      });
      const imageParts = built.messages.flatMap((message) => message.content).filter((part) => part.type === 'image');
      expect(imageParts.length === 2, 'the primary image and custom emoji atlas both reach the model');
      expect(imageParts.some((part) => part.mediaKind === 'custom_emoji_atlas'), 'the atlas remains identifiable');
    },
  },
];

const results: CaseResult[] = [];
try {
  for (const testCase of cases) results.push(await runCase(testCase.name, testCase.body));
} finally {
  await new Promise<void>((resolve, reject) => converter.close((error) => error ? reject(error) : resolve()));
  await sequelize.close();
  await rm(tempDirectory, { recursive: true, force: true });
}
reportResults(results);
