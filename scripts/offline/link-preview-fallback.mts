/**
 * Link preview acquisition: message path → URL fallback → stored outcome
 * (design 2026-1120-1819, sections 5.2 / 5.3 / 5.4 / 7.1).
 *
 * - a private chat has no MTProto channel: only the URL fallback can produce
 *   its preview, and its media must land under the same MediaCache key as the
 *   message path;
 * - a message path that answers 'none' because the first message of a re-posted
 *   link was deleted is not final any more: the URL fallback repairs the row
 *   (the pollution from issue #13);
 * - an old luoxu without /preview-url degrades to today's behavior (message
 *   path only, probed once per process), it never writes a 'none' for a URL it
 *   could not check;
 * - temporary failures are stored as 'error' and reach the context as a
 *   `[system] 链接预览抓取失败` line, a confirmed 'none' as `[system] 链接预览：
 *   Telegram 没有为该链接生成网页预览。` (issue #12);
 * - t.me links never use the URL fallback (they have their own snapshot path);
 * - a stored 'none' is retried only after its cooldown;
 * - two concurrent messages for one URL make a bounded number of requests.
 *
 * luoxu is a local stub; no network. Run:
 * npx tsx scripts/offline/link-preview-fallback.mts
 */
import { createHash } from 'node:crypto';
import type { Chat, Update, User } from 'grammy/types';
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import { createFakeBot, groupChat, quietly, waitUntil } from './fake-telegram.mts';
import { startStubServer } from './support/stub-server.mts';
import type { ModelCapabilities, UnifiedMessage } from '../../src/ai/types.js';

const PNG_BYTES = Buffer.from('offline-preview-image-bytes');

interface StubMedia {
    readonly which: string;
    readonly mime: string;
    readonly bytes: Buffer;
}

interface ReadyPreview {
    readonly title: string;
    readonly media: readonly StubMedia[];
}

/** Message-path previews by message id; a missing id answers 'none' */
const messagePreviews = new Map<number, ReadyPreview>();
/** URL-path previews by URL */
const urlPreviews = new Map<string, ReadyPreview>();
/** URL-path answers that are not a ready/none payload */
const urlFailures = new Map<string, 'http404' | 'http500'>();
/** Delay before answering /preview-url, to make concurrent requests overlap */
let urlResponseDelayMs = 0;

interface AskedRequest {
    readonly path: string;
    readonly messageId: number | null;
    readonly url: string | null;
}
const asked: AskedRequest[] = [];
const askedTo = (path: string): AskedRequest[] => asked.filter((entry) => entry.path === path);

const jsonAnswer = (response: import('node:http').ServerResponse, body: unknown): void => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
};

const readyPayload = (preview: ReadyPreview) => ({
    status: 'ready',
    site_name: 'example.com',
    title: preview.title,
    description: '离线预览描述',
    media: preview.media.map((item) => ({
        which: item.which,
        kind: 'image',
        mime: item.mime,
        size: item.bytes.length,
    })),
});

const luoxu = await startStubServer();
luoxu.handle((request, response) => {
    const parsed = new URL(request.url ?? '/', 'http://stub');
    const rawMessageId = parsed.searchParams.get('id');
    const messageId = rawMessageId === null ? null : Number(rawMessageId);
    const url = parsed.searchParams.get('url');
    asked.push({ path: parsed.pathname, messageId: Number.isNaN(messageId) ? null : messageId, url });

    if (parsed.pathname === '/preview') {
        const preview = messageId === null ? undefined : messagePreviews.get(messageId);
        jsonAnswer(response, preview === undefined ? { status: 'none' } : readyPayload(preview));
        return;
    }

    if (parsed.pathname === '/preview-url') {
        const failure = url === null ? 'http500' : urlFailures.get(url);
        const preview = url === null ? undefined : urlPreviews.get(url);
        setTimeout(() => {
            if (failure !== undefined) {
                response.writeHead(failure === 'http404' ? 404 : 500, { 'Content-Type': 'text/plain' });
                response.end('stub failure');
                return;
            }
            jsonAnswer(response, preview === undefined ? { status: 'none' } : readyPayload(preview));
        }, urlResponseDelayMs);
        return;
    }

    if (parsed.pathname === '/preview-url-media' || parsed.pathname === '/preview-media') {
        const preview = url === null ? undefined : urlPreviews.get(url);
        const which = parsed.searchParams.get('which');
        const media = preview?.media.find((item) => item.which === which);
        if (media === undefined) {
            response.writeHead(404, { 'Content-Type': 'text/plain' });
            response.end('no such media');
            return;
        }
        response.writeHead(200, { 'Content-Type': media.mime });
        response.end(media.bytes);
        return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('unknown endpoint');
});

// Read at import by the preview service and autoSave; the OCR service stays off.
process.env.LUOXU_PREVIEW_URL = luoxu.url;
delete process.env.LUOXU_OCR_URL;
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
process.env.BOT_USER_ID = '7777';
delete process.env.ALLOWED_CHAT_IDS;

await setupOfflineDb();
const { autoSave } = await import('../../src/ingest/auto-save.js');
const { getMessage } = await import('../../src/db/index.js');
const { LinkPreviewCache } = await import('../../src/db/linkPreviewCacheDTO.js');
const { acquireLinkPreview, getLinkPreviewOutcome } = await import('../../src/services/luoxu-preview-service.js');
const { getCachedMedia } = await import('../../src/services/media-cache-service.js');
const { isAsyncFileSavePending, isAsyncPreviewPending } = await import('../../src/state.js');
const { buildContext } = await import('../../src/reply/context-builder.js');
const { sequelize } = await import('../../src/db/config.js');
const { runSchemaMigrations } = await import('../../src/db/schema-migrations.js');
const { QueryTypes } = await import('@sequelize/core');

const { bot } = createFakeBot();
autoSave(bot);

const VISION: ModelCapabilities = {
    supportsImageInput: true,
    supportsImageOutput: false,
    supportsSystemPrompt: true,
    requiresMessageMerge: false,
    supportsThinking: false,
    supportsMediaInput: true,
};

/** A supergroup, so luoxu can address it by channel id */
const GROUP_CHAT_ID = -1007800000003;
const GROUP = groupChat(GROUP_CHAT_ID);

let nextUserId = 900_000;
const nextPrivateChat = (): Chat.PrivateChat => {
    nextUserId += 1;
    return { id: nextUserId, type: 'private', first_name: '私聊用户' };
};

const FROM: User = { id: 111, is_bot: false, first_name: '测试用户' };
let nextUpdateId = 1;
/** Every message is newer than the one before, as on Telegram */
let sentAt = 1_800_000_000;

/** Chats a message update can come from here: a private chat or the test group */
type IngestChat = Chat.PrivateChat | Chat.SupergroupChat;

const messageUpdateOf = (chat: IngestChat, messageId: number, text: string): Update => ({
    update_id: (nextUpdateId += 1),
    message: { message_id: messageId, date: (sentAt += 10), chat, from: FROM, text },
});

/** Feed an update and wait until its file and preview work is done */
const ingest = async (chat: IngestChat, messageId: number, text: string): Promise<void> => {
    await quietly(async () => {
        await bot.handleUpdate(messageUpdateOf(chat, messageId, text));
        await waitUntil(
            `the work on message ${messageId} to end`,
            () =>
                !isAsyncPreviewPending(chat.id, messageId) &&
                !isAsyncFileSavePending(chat.id, messageId)
        );
    });
    if ((await getMessage(chat.id, messageId)) === null) {
        throw new Error(`message ${messageId} of chat ${chat.id} was not stored`);
    }
};

const contextOf = async (chatId: number, messageId: number): Promise<UnifiedMessage[]> => {
    const row = await getMessage(chatId, messageId);
    if (row === null) throw new Error(`message ${chatId}/${messageId} not found`);
    const { messages } = await buildContext(row, { capabilities: VISION, model: 'gemini-3.8-flash' });
    return messages;
};

const textPartsOf = (messages: readonly UnifiedMessage[]): string[] =>
    messages.flatMap((message) =>
        message.content.flatMap((part) => (part.type === 'text' && part.text ? [part.text] : []))
    );

const imagePartsOf = (messages: readonly UnifiedMessage[]): number =>
    messages.reduce(
        (count, message) => count + message.content.filter((part) => part.type === 'image').length,
        0
    );

const NONE_STATUS_LINE = '[system] 链接预览：Telegram 没有为该链接生成网页预览。';
const ERROR_STATUS_LINE = '[system] 链接预览抓取失败（可重试或换用网页读取工具）。';

/** Same key shape as the service, so the message and URL paths share one media row */
const previewMediaKeyOf = (url: string, which: string): string =>
    `luoxu-preview:${createHash('sha256').update(url).digest('hex').slice(0, 24)}:${which}`;

const columnNamesOf = async (tableName: string): Promise<Set<string>> => {
    const rows = await sequelize.query<{ name: string }>(`PRAGMA table_info(${tableName})`, {
        type: QueryTypes.SELECT,
    });
    return new Set(rows.map((row) => row.name));
};

const results: CaseResult[] = [];

results.push(
    await runCase('the new preview columns come from a repeated schema migration', async () => {
        // The fresh setup created the table from the DTO with the columns; drop
        // them (and the ledger entry) so the real ALTER TABLE path runs.
        await sequelize.query('ALTER TABLE link_preview_cache DROP COLUMN lastAttemptAt');
        await sequelize.query('ALTER TABLE link_preview_cache DROP COLUMN source');
        await sequelize.query(
            "DELETE FROM schema_migrations WHERE name = '20261120_link_preview_url_fallback'"
        );

        await runSchemaMigrations();
        await runSchemaMigrations();

        const columns = await columnNamesOf('link_preview_cache');
        expect(columns.has('lastAttemptAt'), 'lastAttemptAt exists after the migration');
        expect(columns.has('source'), 'source exists after the migration');
        const records = await sequelize.query<{ name: string }>(
            "SELECT name FROM schema_migrations WHERE name = '20261120_link_preview_url_fallback'",
            { type: QueryTypes.SELECT }
        );
        expect(records.length === 1, `the migration is recorded once (got ${records.length})`);
    })
);

results.push(
    await runCase('a private chat gets its preview from the URL fallback, media included', async () => {
        const chat = nextPrivateChat();
        const url = 'https://example.com/private-post';
        urlPreviews.set(url, {
            title: '私聊预览',
            media: [{ which: 'photo', mime: 'image/jpeg', bytes: PNG_BYTES }],
        });

        const messageId = takeMessageId();
        await ingest(chat, messageId, `看看这个 ${url}`);

        expect(
            !askedTo('/preview').some((entry) => entry.messageId === messageId),
            'a private chat never asks the message path'
        );
        expect(
            askedTo('/preview-url').some((entry) => entry.url === url),
            'the URL fallback is asked'
        );
        expect(
            askedTo('/preview-url-media').some((entry) => entry.url === url),
            'the URL media endpoint is asked for the preview image'
        );

        const row = await LinkPreviewCache.findByPk(url);
        expect(row?.status === 'ready', `the URL row is ready (${row?.status})`);
        expect(row?.source === 'url', `the row names the URL source (${row?.source})`);
        expect(row?.lastAttemptAt instanceof Date, 'lastAttemptAt is written');
        expect((await getCachedMedia(previewMediaKeyOf(url, 'photo'))) !== null, 'media is stored under the shared key');

        const messages = await contextOf(chat.id, messageId);
        const texts = textPartsOf(messages);
        expect(
            texts.some((text) => text.includes('标题: 私聊预览')),
            `the preview reaches the context (${JSON.stringify(texts)})`
        );
        expect(imagePartsOf(messages) === 1, `the preview image is attached once (got ${imagePartsOf(messages)})`);
        expect(!texts.includes(NONE_STATUS_LINE), 'no "no preview" status line for a ready preview');
    })
);

results.push(
    await runCase('a ready message-path preview never asks the URL fallback', async () => {
        const url = 'https://example.com/group-post';
        const messageId = takeMessageId();
        messagePreviews.set(messageId, { title: '群内预览', media: [] });
        urlPreviews.set(url, { title: '不应被使用', media: [] });

        await ingest(GROUP, messageId, `群里的链接 ${url}`);

        expect(
            askedTo('/preview').some((entry) => entry.messageId === messageId),
            'the message path is asked'
        );
        expect(
            !askedTo('/preview-url').some((entry) => entry.url === url),
            'the URL fallback is not asked'
        );

        const row = await LinkPreviewCache.findByPk(url);
        expect(row?.status === 'ready', `the row is ready (${row?.status})`);
        expect(row?.source === 'message', `the row names the message source (${row?.source})`);

        const texts = textPartsOf(await contextOf(GROUP_CHAT_ID, messageId));
        expect(texts.some((text) => text.includes('标题: 群内预览')), 'the preview reaches the context');
    })
);

results.push(
    await runCase('a deleted first message no longer poisons the URL: the URL fallback repairs it', async () => {
        // The live scenario of issue #13: the message whose preview was being
        // fetched got deleted while pending (luoxu then answers 'none'), while
        // the same URL still has a real preview.
        const url = 'https://fxtwitter.com/someone/status/2123350007625781265';
        const messageId = takeMessageId();
        // no messagePreviews entry: the message path answers 'none'
        urlPreviews.set(url, { title: '被删首条的推文', media: [] });

        await ingest(GROUP, messageId, `${url}`);

        const row = await LinkPreviewCache.findByPk(url);
        expect(row?.status === 'ready', `the URL row is repaired to ready (${row?.status})`);
        expect(row?.source === 'url', `the row names the URL source (${row?.source})`);

        const texts = textPartsOf(await contextOf(GROUP_CHAT_ID, messageId));
        expect(
            texts.some((text) => text.includes('标题: 被删首条的推文')),
            `the context carries the preview (${JSON.stringify(texts)})`
        );
        expect(!texts.includes(NONE_STATUS_LINE), 'no "no preview" status line');
    })
);

results.push(
    await runCase('a temporary URL failure is stored as error and reaches the context', async () => {
        const chat = nextPrivateChat();
        const url = 'https://example.com/temporary-failure';
        urlFailures.set(url, 'http500');

        const messageId = takeMessageId();
        await ingest(chat, messageId, `打不开的链接 ${url}`);

        const row = await LinkPreviewCache.findByPk(url);
        expect(row?.status === 'error', `the row is an error (${row?.status})`);
        expect(row?.source === 'url', `the row names the URL source (${row?.source})`);

        const texts = textPartsOf(await contextOf(chat.id, messageId));
        expect(texts.includes(ERROR_STATUS_LINE), `the fetch-failure line is injected (${JSON.stringify(texts)})`);
        expect(!texts.includes(NONE_STATUS_LINE), 'a failure is not reported as "no preview"');
    })
);

results.push(
    await runCase('a URL with no Telegram preview is stored as none and says so', async () => {
        const chat = nextPrivateChat();
        const url = 'https://example.com/genuinely-no-preview';

        const messageId = takeMessageId();
        await ingest(chat, messageId, `没有预览的链接 ${url}`);

        const row = await LinkPreviewCache.findByPk(url);
        expect(row?.status === 'none', `the row is none (${row?.status})`);
        expect(row?.source === 'url', `the row names the URL source (${row?.source})`);

        const texts = textPartsOf(await contextOf(chat.id, messageId));
        expect(texts.includes(NONE_STATUS_LINE), `the "no preview" line is injected (${JSON.stringify(texts)})`);
    })
);

results.push(
    await runCase('a t.me link keeps the old message-path behavior and asks no URL preview', async () => {
        const url = 'https://t.me/somechannel/123';
        const messageId = takeMessageId();
        const urlRequestsBefore = askedTo('/preview-url').length;

        const preview = await acquireLinkPreview(GROUP_CHAT_ID, messageId, url);
        expect(preview === null, 'no preview is returned');
        expect(
            askedTo('/preview').some((entry) => entry.messageId === messageId),
            'the message path is asked'
        );
        expect(
            askedTo('/preview-url').length === urlRequestsBefore,
            'the URL fallback is never asked for a t.me link'
        );

        const row = await LinkPreviewCache.findByPk(url);
        expect(row?.status === 'none', `old behavior kept: the message-path none is cached (${row?.status})`);

        const outcome = await getLinkPreviewOutcome(url);
        expect(
            outcome.kind === 'unavailable' && outcome.reason === 'unknown',
            'a t.me link gets no preview status line'
        );
    })
);

results.push(
    await runCase('a stored none is retried only after its cooldown', async () => {
        const chat = nextPrivateChat();
        const url = 'https://example.com/cooling-down';
        const seeded = await LinkPreviewCache.create({
            url,
            status: 'none',
            lastAttemptAt: new Date(),
            lastUsedAt: new Date(),
        });

        const requestsBefore = askedTo('/preview-url').length;
        const firstId = takeMessageId();
        await ingest(chat, firstId, `冷却中 ${url}`);
        expect(
            askedTo('/preview-url').length === requestsBefore,
            'a fresh none outcome is not fetched again'
        );

        seeded.lastAttemptAt = new Date(Date.now() - 11 * 60 * 1000);
        await seeded.save();
        const secondId = takeMessageId();
        await ingest(chat, secondId, `冷却已过 ${url}`);
        expect(
            askedTo('/preview-url').length === requestsBefore + 1,
            `an expired none outcome is retried (got ${askedTo('/preview-url').length - requestsBefore})`
        );

        const row = await LinkPreviewCache.findByPk(url);
        expect(row?.status === 'none', `it is still a none outcome (${row?.status})`);
        const refreshedAttemptAt = row?.lastAttemptAt ?? null;
        const expiredAttemptAt = seeded.lastAttemptAt ?? new Date(0);
        expect(
            refreshedAttemptAt !== null && refreshedAttemptAt.getTime() > expiredAttemptAt.getTime(),
            'the retry refreshed lastAttemptAt'
        );
    })
);

results.push(
    await runCase('two messages for one URL make a bounded number of requests and end ready', async () => {
        const chatA = nextPrivateChat();
        const chatB = nextPrivateChat();
        const url = 'https://example.com/concurrent';
        urlPreviews.set(url, { title: '并发预览', media: [] });
        urlResponseDelayMs = 200;

        const requestsBefore = askedTo('/preview-url').length;
        const previews = await Promise.all([
            acquireLinkPreview(chatA.id, takeMessageId(), url),
            acquireLinkPreview(chatB.id, takeMessageId(), url),
        ]);
        urlResponseDelayMs = 0;

        const requests = askedTo('/preview-url').length - requestsBefore;
        expect(requests >= 1, `at least one URL request is made (got ${requests})`);
        expect(requests <= 2, `concurrent messages make a bounded number of requests (got ${requests})`);
        expect(previews.some((preview) => preview !== null), 'the shared result is returned to the callers');

        const row = await LinkPreviewCache.findByPk(url);
        expect(row?.status === 'ready', `the URL ends ready (${row?.status})`);
        expect(row?.source === 'url', `the row names the URL source (${row?.source})`);
    })
);

// Last: it marks the URL endpoint as missing for the rest of the process.
results.push(
    await runCase('an old luoxu without /preview-url degrades without caching a none', async () => {
        const chat = nextPrivateChat();
        const url = 'https://example.com/old-luoxu';
        urlFailures.set(url, 'http404');

        const firstId = takeMessageId();
        await ingest(chat, firstId, `旧 luoxu ${url}`);
        expect(
            askedTo('/preview-url').some((entry) => entry.url === url),
            'the endpoint is probed with the first URL'
        );
        expect((await LinkPreviewCache.findByPk(url)) === null, 'a missing endpoint writes no outcome');

        const probesBefore = askedTo('/preview-url').length;
        const secondId = takeMessageId();
        await ingest(chat, secondId, `旧 luoxu 再试 ${url}`);
        expect(
            askedTo('/preview-url').length === probesBefore,
            'later acquisitions remember that the endpoint is missing'
        );

        const texts = textPartsOf(await contextOf(chat.id, secondId));
        expect(
            !texts.includes(NONE_STATUS_LINE) && !texts.includes(ERROR_STATUS_LINE),
            `no status line without a stored outcome (${JSON.stringify(texts)})`
        );
    })
);

await luoxu.close();
reportResults(results);
