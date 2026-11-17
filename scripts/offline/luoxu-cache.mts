/**
 * Offline cases for the luoxu read caches.
 *
 * Two halves:
 * - `luoxu-response-cache` alone, on a fake clock: TTL, LRU eviction, failures
 *   left unremembered, one in-flight load per key, clearing by namespace, the
 *   `LUOXU_CACHE=0` kill switch;
 * - the real archive client against a local stub that counts requests: every
 *   read endpoint answers a repeated read from the cache, an expired entry
 *   goes back to luoxu, failures are retried, and one archived image is
 *   downloaded once into MediaCache (no GCS) with the thumbnail as its own row.
 *
 * No network: the client's fetch refuses anything but the stub.
 *
 * Run: `pnpm test:offline luoxu-cache`
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import { startStubServer } from './support/stub-server.mts';

// ---------------------------------------------------------------------------
// Local stub: every request is recorded, the current case installs a responder
// ---------------------------------------------------------------------------

const stub = await startStubServer();

interface StubRequest {
    readonly method: string;
    readonly path: string;
    readonly search: string;
}

interface StubRoute extends StubRequest {
    /** The path below `/luoxu`, e.g. `/search` */
    readonly route: string;
}

type Responder = (request: StubRoute, response: ServerResponse) => void;

const requests: StubRoute[] = [];

const notInstalled: Responder = (request, response) => {
    console.error(`    [stub] unexpected ${request.method} ${request.path}${request.search}`);
    response.writeHead(503, { 'Content-Type': 'text/plain' });
    response.end('no responder installed');
};

let responder: Responder = notInstalled;

stub.handle((incoming: IncomingMessage, response: ServerResponse) => {
    const url = new URL(incoming.url ?? '/', stub.url);
    const request: StubRoute = {
        method: incoming.method ?? '',
        path: url.pathname,
        search: url.search,
        route: url.pathname.replace(/^\/luoxu/, ''),
    };
    requests.push(request);
    responder(request, response);
});

/** Read at import by nothing here, but the guard proves every request is local */
const outboundRequests: string[] = [];
const guardedFetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(stub.url)) {
        outboundRequests.push(url);
        throw new Error(`offline: blocked a request to ${url}`);
    }
    return fetch(input, init);
};

await setupOfflineDb();
const { createLuoxuResponseCache, clearLuoxuResponseCache } = await import(
    '../../src/services/luoxu-response-cache.js'
);
const { createHistoryService, HistoryRequestError } = await import('../../src/services/luoxu-history-service.js');
const { getCachedMedia, putCachedMedia } = await import('../../src/services/media-cache-service.js');

const history = createHistoryService({ baseUrl: `${stub.url}/luoxu`, fetchImpl: guardedFetch });

delete process.env.LUOXU_CACHE;

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const CHANNEL_ID = 1415974153;
const GROUP_TITLE = '测试群';
const MESSAGE_ID = 1115908;
const SENDER_ID = 603421700;
const TIMESTAMP = 1794917806;
const DELETED_AT = 1794918500;
const EDITED_AT = 1794917900;

/** A JPEG-looking body: the size is what the cache cap is about, not the codec */
const jpeg = (extraBytes = 400): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(extraBytes)]);

/** MediaCache key of one archived image, as the design specifies it */
const imageCacheKey = (channelId: number, messageId: number, which: string, thumb: boolean): string =>
    `luoxu-history-image:${createHash('sha256')
        .update(`${channelId}:${messageId}:${which}:${thumb ? 1 : 0}`)
        .digest('hex')}`;

const jsonResponse = (response: ServerResponse, payload: unknown): void => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
};

const bytesResponse = (response: ServerResponse, data: Buffer, mime = 'image/jpeg'): void => {
    response.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length });
    response.end(data);
};

const statusResponse = (response: ServerResponse, status: number): void => {
    response.writeHead(status, { 'Content-Type': 'text/plain' });
    response.end(`HTTP ${status}`);
};

const searchPayload = (
    messages: readonly Readonly<Record<string, unknown>>[] = [
        {
            id: MESSAGE_ID,
            from_id: SENDER_ID,
            from_name: '黑猫',
            group_id: CHANNEL_ID,
            html: '正文 <span class="keyword">显卡</span>',
            t: TIMESTAMP,
            edited: null,
        },
    ]
): unknown => ({
    messages,
    groupinfo: { [String(CHANNEL_ID)]: [CHANNEL_ID, GROUP_TITLE] },
    has_more: false,
});

const messagesPayload = (ids: readonly number[]): unknown => ({
    messages: ids.map((id) => ({
        id,
        sender_id: SENDER_ID,
        sender_name: '黑猫',
        sender_is_bot: false,
        text: '一条归档消息',
        entities: [],
        reply_to_id: null,
        media: null,
        images: 0,
        date: TIMESTAMP,
    })),
});

const namesPayload = (): unknown => ({ names: [[SENDER_ID, '黑猫']] });

const imagesPayload = (): unknown => ({
    images: [
        { which: 'media', source: 'media', kind: 'photo', mime: 'image/jpeg', size: 400, width: 800, height: 600 },
        { which: 'page_photo_0', source: 'page', kind: 'photo', mime: 'image/jpeg', size: 5120, width: 800, height: 600 },
    ],
    media: null,
});

const statsPayload = (): unknown => ({
    groups: [
        {
            group_id: CHANNEL_ID,
            name: GROUP_TITLE,
            messages: 1200,
            first_t: TIMESTAMP - 1000,
            last_t: TIMESTAMP,
        },
    ],
});

/** Answers every endpoint with its fixture, for cases that only count requests */
const answeringAll: Responder = (request, response) => {
    if (request.route === '/search') return jsonResponse(response, searchPayload());
    if (request.route === '/messages') return jsonResponse(response, messagesPayload([MESSAGE_ID]));
    if (request.route === '/names') return jsonResponse(response, namesPayload());
    if (request.route === '/message-images') return jsonResponse(response, imagesPayload());
    if (request.route === '/stats') return jsonResponse(response, statsPayload());
    statusResponse(response, 404);
};

const requestsTo = (route: string): StubRoute[] => requests.filter((request) => request.route === route);

/** Every case starts from an empty response cache and an unarmed stub */
const prepareCase = (): void => {
    requests.length = 0;
    responder = notInstalled;
    clearLuoxuResponseCache();
};

const rejectionOf = async (work: () => Promise<unknown>): Promise<unknown> => {
    try {
        await work();
    } catch (error) {
        return error;
    }
    return null;
};

const kindOf = (error: unknown): string =>
    error instanceof HistoryRequestError ? error.kind : `not a HistoryRequestError: ${String(error)}`;

const withKillSwitch = async (body: () => Promise<void>): Promise<void> => {
    const previous = process.env.LUOXU_CACHE;
    process.env.LUOXU_CACHE = '0';
    try {
        await body();
    } finally {
        if (previous === undefined) delete process.env.LUOXU_CACHE;
        else process.env.LUOXU_CACHE = previous;
    }
};

/** A clock the cases can move without waiting for real TTLs */
const withShiftedClock = async (offsetMs: number, body: () => Promise<void>): Promise<void> => {
    const realNow = Date.now;
    Date.now = () => realNow() + offsetMs;
    try {
        await body();
    } finally {
        Date.now = realNow;
    }
};

const cases: CaseResult[] = [];

// ---------------------------------------------------------------------------
// The cache module, on a fake clock
// ---------------------------------------------------------------------------

cases.push(
    await runCase('a cached load is reused inside its ttl and reloaded after it', async () => {
        let clock = 1000;
        const cache = createLuoxuResponseCache(() => clock);
        let loads = 0;
        const load = async (): Promise<number> => {
            loads += 1;
            return loads;
        };

        expect((await cache.cachedJson('search', 'k', 1000, 8, load)) === 1, 'the first call loads');
        clock = 1999;
        expect((await cache.cachedJson('search', 'k', 1000, 8, load)) === 1, 'a hit just before the deadline reuses the value');
        expect(loads === 1, 'the hit did not call the loader');
        clock = 2000;
        expect((await cache.cachedJson('search', 'k', 1000, 8, load)) === 2, 'the deadline itself is expired');
        expect(loads === 2, 'expiry loaded again');
    })
);

cases.push(
    await runCase('the least recently used key is evicted when a namespace is full', async () => {
        let clock = 0;
        const cache = createLuoxuResponseCache(() => clock);
        const loads = new Map<string, number>();
        const loadOf = (key: string) => async (): Promise<string> => {
            loads.set(key, (loads.get(key) ?? 0) + 1);
            return key;
        };

        await cache.cachedJson('search', 'a', 10_000, 2, loadOf('a'));
        await cache.cachedJson('search', 'b', 10_000, 2, loadOf('b'));
        // A hit makes `a` the newest, so `b` becomes the one to drop
        await cache.cachedJson('search', 'a', 10_000, 2, loadOf('a'));
        await cache.cachedJson('search', 'c', 10_000, 2, loadOf('c'));
        expect((loads.get('b') ?? 0) === 1, 'the evicted key was not loaded again by the insertion');

        await cache.cachedJson('search', 'a', 10_000, 2, loadOf('a'));
        expect((loads.get('a') ?? 0) === 1, 'the recently used key survived');
        // `c` was the oldest when `b` came back, so `b` pushes `c` out
        await cache.cachedJson('search', 'b', 10_000, 2, loadOf('b'));
        expect((loads.get('b') ?? 0) === 2, 'the evicted key misses and loads again');
        expect((loads.get('c') ?? 0) === 1, 'the key evicted earlier was not reloaded meanwhile');

        await cache.cachedJson('search', 'c', 10_000, 2, loadOf('c'));
        expect((loads.get('c') ?? 0) === 2, 'each insertion pushes out the least recently used key');
        expect((loads.get('a') ?? 0) === 1, 'the hit key was not loaded again by the last insertion');
    })
);

cases.push(
    await runCase('a failed load is not remembered', async () => {
        let clock = 0;
        const cache = createLuoxuResponseCache(() => clock);
        let loads = 0;
        const load = async (): Promise<string> => {
            loads += 1;
            if (loads === 1) throw new Error('luoxu is down');
            return 'ok';
        };

        const failure = await rejectionOf(() => cache.cachedJson('messages', 'k', 60_000, 8, load));
        expect(failure instanceof Error && failure.message === 'luoxu is down', 'the caller sees the loader error');
        expect((await cache.cachedJson('messages', 'k', 60_000, 8, load)) === 'ok', 'the retry is not given the failure');
        expect(loads === 2, 'the failed promise was not kept');
    })
);

cases.push(
    await runCase('concurrent callers of one key share one in-flight load', async () => {
        const cache = createLuoxuResponseCache(() => 0);
        let loads = 0;
        let release: (value: string) => void = () => {};
        const load = (): Promise<string> => {
            loads += 1;
            return new Promise((resolve) => {
                release = resolve;
            });
        };

        const first = cache.cachedJson('names', 'k', 10_000, 8, load);
        const second = cache.cachedJson('names', 'k', 10_000, 8, load);
        expect(loads === 1, 'the second call did not start a load');
        release('shared');
        const [left, right] = await Promise.all([first, second]);
        expect(left === 'shared' && right === 'shared', 'both callers get the same value');
        expect(loads === 1, 'one load served both');
    })
);

cases.push(
    await runCase('clear forgets one namespace or all of them', async () => {
        const clock = 0;
        const cache = createLuoxuResponseCache(() => clock);
        const loads = new Map<string, number>();
        const loadOf = (key: string) => async (): Promise<string> => {
            loads.set(key, (loads.get(key) ?? 0) + 1);
            return key;
        };

        await cache.cachedJson('search', 'k', 10_000, 8, loadOf('search'));
        await cache.cachedJson('messages', 'k', 10_000, 8, loadOf('messages'));
        cache.clear('search');
        await cache.cachedJson('search', 'k', 10_000, 8, loadOf('search'));
        expect((loads.get('search') ?? 0) === 2, 'the cleared namespace loads again');
        await cache.cachedJson('messages', 'k', 10_000, 8, loadOf('messages'));
        expect((loads.get('messages') ?? 0) === 1, 'another namespace kept its entry');

        cache.clear();
        await cache.cachedJson('search', 'k', 10_000, 8, loadOf('search'));
        await cache.cachedJson('messages', 'k', 10_000, 8, loadOf('messages'));
        expect((loads.get('search') ?? 0) === 3, 'clear() forgot the first namespace');
        expect((loads.get('messages') ?? 0) === 2, 'clear() forgot the second one too');
    })
);

cases.push(
    await runCase('the kill switch bypasses the cache without touching it', async () => {
        const clock = 0;
        const cache = createLuoxuResponseCache(() => clock);
        let loads = 0;
        const load = async (): Promise<string> => {
            loads += 1;
            return `value ${loads}`;
        };

        await cache.cachedJson('search', 'k', 10_000, 8, load);
        await withKillSwitch(async () => {
            expect((await cache.cachedJson('search', 'k', 10_000, 8, load)) === 'value 2', 'a disabled cache loads');
            expect((await cache.cachedJson('search', 'k', 10_000, 8, load)) === 'value 3', 'and does it again');
            expect((await cache.cachedJson('messages', 'k', 10_000, 8, load)) === 'value 4', 'nothing is stored either');
        });
        expect((await cache.cachedJson('search', 'k', 10_000, 8, load)) === 'value 1', 'the entry from before the switch survived');
        expect(loads === 4, `a disabled cache made every call load (${loads} loads)`);
    })
);

// ---------------------------------------------------------------------------
// The archive client against the stub
// ---------------------------------------------------------------------------

cases.push(
    await runCase('each read endpoint is answered from the cache once within its ttl', async () => {
        prepareCase();
        responder = answeringAll;
        const searchOptions = { channelId: CHANNEL_ID, query: '显卡' };

        const firstSearch = await history.search(searchOptions);
        const secondSearch = await history.search(searchOptions);
        const senders = await history.findSenders(CHANNEL_ID, '黑猫');
        const againSenders = await history.findSenders(CHANNEL_ID, '黑猫');
        const raw = await history.messages(CHANNEL_ID, [MESSAGE_ID]);
        const againRaw = await history.messages(CHANNEL_ID, [MESSAGE_ID]);
        const manifest = await history.images(CHANNEL_ID, MESSAGE_ID);
        const againManifest = await history.images(CHANNEL_ID, MESSAGE_ID);
        const stats = await history.stats(CHANNEL_ID);
        const againStats = await history.stats(CHANNEL_ID);

        expect(requestsTo('/search').length === 1, `the repeated search reached luoxu once (${requestsTo('/search').length})`);
        expect(requestsTo('/names').length === 1, 'the repeated name lookup reached luoxu once');
        expect(requestsTo('/messages').length === 1, 'the repeated message read reached luoxu once');
        expect(requestsTo('/message-images').length === 1, 'the repeated manifest read reached luoxu once');
        expect(requestsTo('/stats').length === 1, 'the repeated coverage read reached luoxu once');

        expect(
            firstSearch.hits.length === 1 && secondSearch.hits.length === 1,
            'both searches return the same hit count'
        );
        const hit = firstSearch.hits[0];
        expect(
            hit?.messageId === MESSAGE_ID &&
                hit.channelId === CHANNEL_ID &&
                hit.fromId === SENDER_ID &&
                hit.fromName === '黑猫' &&
                hit.timestamp === TIMESTAMP &&
                hit.html.includes('显卡'),
            'a cached hit keeps every parsed field'
        );
        expect(firstSearch.groups.get(CHANNEL_ID) === GROUP_TITLE, 'the group title survives the cache');
        expect(secondSearch.groups.get(CHANNEL_ID) === GROUP_TITLE, 'and is the same on a hit');
        expect(senders.length === 1 && againSenders.length === 1 && senders[0]?.uid === SENDER_ID, 'senders are cached');
        expect(raw.length === 1 && againRaw.length === 1 && raw[0]?.messageId === MESSAGE_ID, 'messages are cached');
        expect(
            manifest.images.length === 2 &&
                againManifest.images.length === 2 &&
                manifest.images[1]?.which === 'page_photo_0',
            'the image manifest is cached'
        );
        expect(
            stats.groups.length === 1 && againStats.groups.length === 1 && stats.groups[0]?.messages === 1200,
            'coverage is cached'
        );

        // A different request shape is a different key
        await history.messages(CHANNEL_ID, [MESSAGE_ID, MESSAGE_ID + 1]);
        await history.search({ ...searchOptions, limit: 50 });
        expect(requestsTo('/messages').length === 2, 'a different id list is a new request');
        expect(requestsTo('/search').length === 2, 'a different limit is a new request');
    })
);

cases.push(
    await runCase('the ids mode and the page mode are separate cache keys', async () => {
        prepareCase();
        responder = answeringAll;
        const ids = [MESSAGE_ID, MESSAGE_ID + 1];

        await history.search({ channelId: CHANNEL_ID, ids });
        await history.search({ channelId: CHANNEL_ID, ids });
        await history.search({ channelId: CHANNEL_ID, ids, limit: 50 });
        await history.search({ channelId: CHANNEL_ID, ids: [MESSAGE_ID + 2] });
        expect(requestsTo('/search').length === 3, `id reads with three shapes made three requests (${requestsTo('/search').length})`);

        const bad = await rejectionOf(() => history.search({ channelId: null, ids }));
        expect(kindOf(bad) === 'bad-query', 'ids without a chat are still refused locally');
        expect(requestsTo('/search').length === 3, 'the local refusal never reaches luoxu');
    })
);

cases.push(
    await runCase('search hits carry the deleted marker from luoxu', async () => {
        prepareCase();
        responder = (request, response) => {
            if (request.route === '/search') {
                jsonResponse(
                    response,
                    searchPayload([
                        {
                            id: MESSAGE_ID,
                            from_id: SENDER_ID,
                            from_name: '黑猫',
                            group_id: CHANNEL_ID,
                            html: '被删除的一条',
                            t: TIMESTAMP,
                            edited: null,
                            deleted: DELETED_AT,
                        },
                        {
                            id: MESSAGE_ID + 1,
                            from_id: SENDER_ID,
                            from_name: '黑猫',
                            group_id: CHANNEL_ID,
                            html: '还在的一条',
                            t: TIMESTAMP - 60,
                            edited: EDITED_AT,
                        },
                    ])
                );
                return;
            }
            statusResponse(response, 404);
        };

        const outcome = await history.search({ channelId: CHANNEL_ID, query: '显卡' });
        const [deleted, alive] = outcome.hits;
        expect(deleted?.deletedAt === DELETED_AT, `the deleted hit carries luoxu's timestamp (${deleted?.deletedAt})`);
        expect(deleted?.editedAt === null, 'its edit stamp stays null');
        expect(alive?.deletedAt === null, 'a hit without the field is not marked');
        expect(alive?.editedAt === EDITED_AT, 'the edit stamp is untouched');
        expect(outcome.hits.length === 2, 'both rows are returned');
    })
);

cases.push(
    await runCase('an expired entry is loaded from luoxu again', async () => {
        prepareCase();
        responder = answeringAll;

        await history.messages(CHANNEL_ID, [MESSAGE_ID]);
        await history.messages(CHANNEL_ID, [MESSAGE_ID]);
        expect(requestsTo('/messages').length === 1, 'the first reads share one request');

        await withShiftedClock(61_000, async () => {
            await history.messages(CHANNEL_ID, [MESSAGE_ID]);
        });
        expect(requestsTo('/messages').length === 2, `past the 60s ttl luoxu is asked again (${requestsTo('/messages').length})`);
    })
);

cases.push(
    await runCase('a luoxu failure keeps its kind and is not cached', async () => {
        prepareCase();
        let attempts = 0;
        responder = (request, response) => {
            if (request.route !== '/search') return statusResponse(response, 404);
            attempts += 1;
            if (attempts === 1) return statusResponse(response, 503);
            if (attempts === 2) return statusResponse(response, 400);
            jsonResponse(response, searchPayload());
        };

        const first = await rejectionOf(() => history.search({ channelId: CHANNEL_ID, query: '显卡' }));
        expect(kindOf(first) === 'unavailable', `a 5xx is unavailable (${kindOf(first)})`);
        const second = await rejectionOf(() => history.search({ channelId: CHANNEL_ID, query: '显卡' }));
        expect(kindOf(second) === 'bad-query', `a 400 stays bad-query (${kindOf(second)})`);
        expect(requestsTo('/search').length === 2, 'neither failure was remembered');

        const recovered = await history.search({ channelId: CHANNEL_ID, query: '显卡' });
        expect(recovered.hits.length === 1, 'the retry succeeds');
        expect(requestsTo('/search').length === 3, 'the successful response is the one that got cached');
        await history.search({ channelId: CHANNEL_ID, query: '显卡' });
        expect(requestsTo('/search').length === 3, 'the cached success is served afterwards');
    })
);

cases.push(
    await runCase('a manifest 404 keeps the missing kind and is not cached', async () => {
        prepareCase();
        let attempts = 0;
        responder = (request, response) => {
            if (request.route !== '/message-images') return statusResponse(response, 404);
            attempts += 1;
            if (attempts === 1) return statusResponse(response, 404);
            jsonResponse(response, imagesPayload());
        };

        const first = await rejectionOf(() => history.images(CHANNEL_ID, MESSAGE_ID));
        expect(kindOf(first) === 'missing', `a gone message is missing, not unavailable (${kindOf(first)})`);
        const manifest = await history.images(CHANNEL_ID, MESSAGE_ID);
        expect(manifest.images.length === 2, 'a later read works');
        expect(requestsTo('/message-images').length === 2, 'the 404 was not remembered');
    })
);

cases.push(
    await runCase('an archived image is downloaded once and kept in the media cache', async () => {
        prepareCase();
        const data = jpeg(700);
        responder = (request, response) => {
            if (request.route === '/message-image') return bytesResponse(response, data, 'image/jpeg');
            statusResponse(response, 404);
        };
        const imageMessageId = 2220001;
        const key = imageCacheKey(CHANNEL_ID, imageMessageId, 'media', false);

        const first = await history.imageBytes(CHANNEL_ID, imageMessageId, 'media');
        const second = await history.imageBytes(CHANNEL_ID, imageMessageId, 'media');
        expect(requestsTo('/message-image').length === 1, 'the second read never reaches luoxu');
        expect(first !== null && second !== null, 'both reads return bytes');
        expect(first?.data.equals(data) === true && second?.data.equals(data) === true, 'the bytes are the downloaded ones');
        expect(first?.mime === 'image/jpeg' && second?.mime === 'image/jpeg', 'the response mime survives the cache');

        const row = await getCachedMedia(key);
        expect(row !== null, 'the image is stored in MediaCache');
        if (row === null) return;
        expect(row.kind === 'history-image', `its kind is history-image (${row.kind})`);
        expect(row.mime === 'image/jpeg', 'the row keeps the response mime');
        expect(row.fileUri === null, 'nothing is written to GCS');
        expect(row.data !== null && row.data.equals(data), 'the row holds the bytes inline');

        // The thumbnail is a different picture and its own row
        const thumb = await history.imageBytes(CHANNEL_ID, imageMessageId, 'media', { thumb: true });
        expect(requestsTo('/message-image').length === 2, 'the thumbnail is asked for separately');
        expect(thumb !== null, 'the thumbnail is read');
        const thumbRow = await getCachedMedia(imageCacheKey(CHANNEL_ID, imageMessageId, 'media', true));
        expect(thumbRow !== null, 'the thumbnail has its own cache row');
        expect(requestsTo('/message-image')[1]?.search.includes('thumb=1') === true, 'the second request asked for thumb=1');
    })
);

cases.push(
    await runCase('an image already in the media cache is served without luoxu', async () => {
        prepareCase();
        responder = answeringAll;
        const imageMessageId = 2220002;
        const key = imageCacheKey(CHANNEL_ID, imageMessageId, 'media', false);
        const data = jpeg(90);
        await putCachedMedia({
            fileUniqueId: key,
            data,
            sizeBytes: data.length,
            mime: 'image/webp',
            kind: 'history-image',
        });

        const bytes = await history.imageBytes(CHANNEL_ID, imageMessageId, 'media');
        expect(requestsTo('/message-image').length === 0, 'no request was made for a cached image');
        expect(bytes?.data.equals(data) === true, 'the cached bytes come back');
        expect(bytes?.mime === 'image/webp', `the row's mime is used, not a response header (${bytes?.mime})`);
    })
);

cases.push(
    await runCase('an image above the inline cap is not cached', async () => {
        prepareCase();
        const imageMessageId = 2220003;
        // 8MB + 4 header bytes: just over the cap
        const oversized = jpeg(8 * 1024 * 1024);
        responder = (request, response) => {
            if (request.route === '/message-image') return bytesResponse(response, oversized, 'image/jpeg');
            statusResponse(response, 404);
        };

        const first = await history.imageBytes(CHANNEL_ID, imageMessageId, 'media');
        const second = await history.imageBytes(CHANNEL_ID, imageMessageId, 'media');
        expect(first?.data.length === oversized.length, 'the oversized image can still be read');
        expect(second !== null, 'and read again');
        expect(requestsTo('/message-image').length === 2, 'both reads downloaded it');
        const row = await getCachedMedia(imageCacheKey(CHANNEL_ID, imageMessageId, 'media', false));
        expect(row === null, 'no inline copy was stored');
    })
);

cases.push(
    await runCase('a failed or missing image download is not cached', async () => {
        prepareCase();
        const imageMessageId = 2220004;
        const data = jpeg(120);
        let attempts = 0;
        responder = (request, response) => {
            if (request.route !== '/message-image') return statusResponse(response, 404);
            attempts += 1;
            if (attempts === 1) return statusResponse(response, 500);
            if (attempts === 2) return statusResponse(response, 404);
            bytesResponse(response, data, 'image/jpeg');
        };

        const failure = await rejectionOf(() => history.imageBytes(CHANNEL_ID, imageMessageId, 'media'));
        expect(kindOf(failure) === 'unavailable', `a 5xx is unavailable (${kindOf(failure)})`);
        const missing = await history.imageBytes(CHANNEL_ID, imageMessageId, 'media');
        expect(missing === null, 'a 404 is the ordinary "no longer there" answer');
        expect(requestsTo('/message-image').length === 2, 'neither outcome was cached');

        const recovered = await history.imageBytes(CHANNEL_ID, imageMessageId, 'media');
        expect(recovered?.data.equals(data) === true, 'a later download works');
        await history.imageBytes(CHANNEL_ID, imageMessageId, 'media');
        expect(requestsTo('/message-image').length === 3, 'only the successful download was cached');
    })
);

cases.push(
    await runCase('concurrent reads share one request', async () => {
        prepareCase();
        responder = answeringAll;
        const searchOptions = { channelId: CHANNEL_ID, query: '并发' };
        const [left, right] = await Promise.all([history.search(searchOptions), history.search(searchOptions)]);
        expect(requestsTo('/search').length === 1, `two searches in flight made one request (${requestsTo('/search').length})`);
        expect(left.hits.length === 1 && right.hits.length === 1, 'both callers get the result');

        const imageMessageId = 2220005;
        responder = (request, response) => {
            if (request.route === '/message-image') return bytesResponse(response, jpeg(50), 'image/jpeg');
            statusResponse(response, 404);
        };
        const [imageLeft, imageRight] = await Promise.all([
            history.imageBytes(CHANNEL_ID, imageMessageId, 'media'),
            history.imageBytes(CHANNEL_ID, imageMessageId, 'media'),
        ]);
        expect(requestsTo('/message-image').length === 1, 'two image reads in flight made one download');
        expect(imageLeft?.data.equals(imageRight?.data ?? Buffer.alloc(0)) === true, 'both callers get the same bytes');
    })
);

cases.push(
    await runCase('the kill switch bypasses both caches', async () => {
        prepareCase();
        const imageMessageId = 2220006;
        const untouchedMessageId = 2220007;
        responder = (request, response) => {
            if (request.route === '/messages') return jsonResponse(response, messagesPayload([MESSAGE_ID]));
            if (request.route === '/message-image') return bytesResponse(response, jpeg(60), 'image/jpeg');
            statusResponse(response, 404);
        };

        await history.messages(CHANNEL_ID, [MESSAGE_ID]);
        await history.imageBytes(CHANNEL_ID, imageMessageId, 'media');
        expect(requestsTo('/messages').length === 1 && requestsTo('/message-image').length === 1, 'both filled their caches');

        await withKillSwitch(async () => {
            await history.messages(CHANNEL_ID, [MESSAGE_ID]);
            await history.messages(CHANNEL_ID, [MESSAGE_ID]);
            expect(requestsTo('/messages').length === 3, 'a disabled cache asks luoxu every time, cached entry or not');
            await history.imageBytes(CHANNEL_ID, imageMessageId, 'media');
            expect(requestsTo('/message-image').length === 2, 'a cached image is downloaded again too');
            await history.imageBytes(CHANNEL_ID, untouchedMessageId, 'media');
            expect(requestsTo('/message-image').length === 3, 'a fresh image is downloaded as usual');
            const row = await getCachedMedia(imageCacheKey(CHANNEL_ID, untouchedMessageId, 'media', false));
            expect(row === null, 'a disabled cache writes nothing either');
        });

        await history.messages(CHANNEL_ID, [MESSAGE_ID]);
        expect(requestsTo('/messages').length === 3, 'the entry from before the switch is still served');
        await history.imageBytes(CHANNEL_ID, imageMessageId, 'media');
        expect(requestsTo('/message-image').length === 3, 'the cached image from before the switch is still served');
        await history.imageBytes(CHANNEL_ID, untouchedMessageId, 'media');
        await history.imageBytes(CHANNEL_ID, untouchedMessageId, 'media');
        expect(requestsTo('/message-image').length === 4, 'the next read fills the cache again, the one after hits it');
    })
);

cases.push(
    await runCase('the stats snapshot keeps its clear hook', async () => {
        prepareCase();
        responder = answeringAll;
        await history.stats(CHANNEL_ID);
        await history.stats(CHANNEL_ID);
        await history.stats(null);
        expect(requestsTo('/stats').length === 2, 'per-chat and cross-group coverage are separate entries');

        const { clearHistoryStatsCache } = await import('../../src/services/luoxu-history-service.js');
        clearHistoryStatsCache();
        await history.stats(CHANNEL_ID);
        await history.stats(CHANNEL_ID);
        expect(requestsTo('/stats').length === 3, 'clearHistoryStatsCache() forgets the per-chat snapshot');
        await history.stats(null);
        expect(requestsTo('/stats').length === 4, 'and the cross-group snapshot with it');
        await history.stats(null);
        expect(requestsTo('/stats').length === 4, 'a reloaded snapshot is cached again');
    })
);

cases.push(
    await runCase('every request went to the local stub', async () => {
        expect(outboundRequests.length === 0, `no request left the stub (${outboundRequests.join(', ')})`);
    })
);

await stub.close();
reportResults(cases);
