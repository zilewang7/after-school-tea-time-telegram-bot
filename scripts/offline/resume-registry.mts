/**
 * Offline cases for the saving side of "继续" that need no reply pipeline
 * (design 2026-1112-1123 §6.2, §6.3, §11 phase 3 cases 15, 17, 18):
 *
 * - the checkpoint registry: expiry, the entry limit, the byte limit, an entry
 *   too big alone, eviction clearing the mark, the compacted journal, shared
 *   strings and buffers counted once, peek / take / put back / drop, entries
 *   dropped once their mark is gone;
 * - why an entry is missing (restart, expired, evicted);
 * - the resumable marks and the button rows that read them;
 * - createReplyTools with the state bundle of an earlier attempt: `g1` still
 *   resolves, search_by_image, the harness issue limit and the workspace
 *   counters go on counting.
 *
 * Run: npx tsx scripts/offline/resume-registry.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import { createFakeTelegram } from './fake-telegram.mts';
import type { StreamChunk } from '../../src/ai/types.js';
import type { ToolLoopCheckpoint } from '../../src/ai/tools/tool-loop-checkpoint.js';

// Read at import by the tool config: the workspace tools are off by default
process.env.WORKSPACE_ENABLE = '1';

await setupOfflineDb();
const state = await import('../../src/state.js');
const { ButtonState } = await import('../../src/db/index.js');
const { buildResponseButtons } = await import('../../src/cmd/menus/response-menu.js');
const { createCheckpointRegistry, CHECKPOINT_REGISTRY_LIMITS } = await import(
    '../../src/reply/resume/checkpoint-registry.js'
);
const { checkpointMissingReason } = await import('../../src/reply/resume/checkpoint-missing-reason.js');
const { estimateCheckpointBytes, estimateRetainedBytes } = await import('../../src/reply/resume/checkpoint-size.js');
const { compactJournal } = await import('../../src/reply/resume/journal-compaction.js');
const { canonicalJson } = await import('../../src/reply/resume/canonical-json.js');
const { captureResumeFacts } = await import('../../src/reply/resume/resume-facts.js');
const replyTools = await import('../../src/reply/tools/index.js');
const { createSearchByImageTool, MAX_SEARCHES_PER_REPLY } = await import('../../src/reply/tools/search-by-image-tool.js');
const { MAX_HARNESS_ISSUES_PER_REPLY } = await import('../../src/reply/tools/harness-issue-state.js');

type ReplyCheckpoint = import('../../src/reply/resume/reply-checkpoint.js').ReplyCheckpoint;
type ReplyToolState = import('../../src/reply/tools/reply-tool-state.js').ReplyToolState;
type InlineKeyboard = import('grammy').InlineKeyboard;

const json = (value: unknown): string => JSON.stringify(value);
const HOUR_MS = 60 * 60 * 1000;
const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);

/** Console output swallowed while `body` runs (the registry logs every keep and eviction) */
const quiet = <T,>(body: () => T): T => {
    const original = console.log;
    console.log = () => undefined;
    try {
        return body();
    } finally {
        console.log = original;
    }
};

/** The labels of a keyboard, row by row flattened */
const labelsOf = (keyboard: InlineKeyboard | undefined): string[] =>
    (keyboard?.inline_keyboard ?? []).flat().map((button) => button.text);

const callbacksOf = (keyboard: InlineKeyboard | undefined): string[] =>
    (keyboard?.inline_keyboard ?? []).flat().map((button) => ('callback_data' in button ? button.callback_data ?? '' : ''));

const toolContextFor = (chatId: number, conversationRootIds: readonly number[] = []) =>
    replyTools.buildReplyToolContext({
        chat: { id: chatId, type: 'supergroup', title: '测试群' },
        triggerMessage: { messageId: 1, userId: 42, userName: '张三', text: '画只猫' },
        contextIndex: new Map(),
        conversationRootIds,
        signal: new AbortController().signal,
        api: createFakeTelegram().api,
    });

const freshToolState = (chatId: number, conversationRootIds: readonly number[] = []): ReplyToolState =>
    replyTools.createReplyToolState({ chatId, conversationRootIds });

const loopCheckpoint = (fields: Partial<ToolLoopCheckpoint> = {}): ToolLoopCheckpoint => ({
    platform: 'gemini',
    completedRounds: 2,
    toolUsage: [{ name: 'search_history', count: 2 }],
    journal: [
        { type: 'thinking', content: '想一想' },
        { type: 'text', content: '先查一下。' },
    ],
    state: { nextRound: 3 },
    ...fields,
});

/** One registry entry for a fresh reply key, saved `savedAt` */
const entryOf = (
    savedAt: number,
    fields: { loop?: ToolLoopCheckpoint; failedVersionId?: number; chatId?: number } = {}
): ReplyCheckpoint => {
    const chatId = fields.chatId ?? -1007300000000 - takeMessageId();
    const toolState = freshToolState(chatId);
    const facts = captureResumeFacts({
        model: 'gemini-4-carbon',
        systemPrompt: '系统提示词',
        tools: { definitions: [], execute: async () => ({ content: '', isError: false, images: [], record: null }), statusOf: () => ({ text: '', chatAction: 'typing' }) },
        toolState,
        contextIndex: new Map(),
        conversationRootIds: [],
        requestTraits: { carriesLargeMedia: false },
        promptAddendum: null,
        builtAt: savedAt,
    });
    return {
        ...facts,
        chatId,
        firstMessageId: takeMessageId(),
        userMessageId: takeMessageId(),
        loop: fields.loop ?? loopCheckpoint(),
        failedVersionId: fields.failedVersionId ?? 1,
        savedAt,
    };
};

/** A loop checkpoint whose opaque state holds `bytes` bytes */
const loopOfSize = (bytes: number): ToolLoopCheckpoint => loopCheckpoint({ state: { blob: Buffer.alloc(bytes) } });

const markOf = (entry: ReplyCheckpoint): number | undefined =>
    state.resumableMarkOf(entry.chatId, entry.firstMessageId, entry.savedAt)?.versionId;

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: 'the button rows: [继续] [重试]; [<] [继续] [重试] [>]; [继续] before the edit button; none without the flag',
        body: async () => {
            expect(
                json(labelsOf(buildResponseButtons(ButtonState.RETRY_ONLY, 0, 1, { resumable: true }))) === json(['继续', '重试']),
                'RETRY_ONLY with a checkpoint'
            );
            expect(
                json(callbacksOf(buildResponseButtons(ButtonState.RETRY_ONLY, 0, 1, { resumable: true }))) ===
                    json(['resp:continue', 'resp:retry']),
                'the continue button sends resp:continue'
            );
            expect(
                json(labelsOf(buildResponseButtons(ButtonState.HAS_VERSIONS, 1, 3, { resumable: true }))) ===
                    json(['<', '继续', '重试', '>']),
                'HAS_VERSIONS keeps the switch buttons around it'
            );
            expect(
                json(labelsOf(buildResponseButtons(ButtonState.HAS_VERSIONS, 2, 3, { resumable: true }))) ===
                    json(['<', '继续', '重试']),
                'on the latest version there is nothing to the right'
            );
            expect(
                json(labelsOf(buildResponseButtons(ButtonState.EDIT_DETECTED, 0, 1, { resumable: true }))) ===
                    json(['继续', '检测到用户编辑，是否重试']),
                'an edit does not hide 继续 (D11)'
            );
            expect(
                json(labelsOf(buildResponseButtons(ButtonState.RETRY_ONLY))) === json(['重试']) &&
                    json(labelsOf(buildResponseButtons(ButtonState.HAS_VERSIONS, 1, 2))) === json(['<', '重试']) &&
                    json(labelsOf(buildResponseButtons(ButtonState.EDIT_DETECTED))) === json(['检测到用户编辑，是否重试']),
                'without the flag the rows are as before'
            );
            expect(
                json(labelsOf(buildResponseButtons(ButtonState.PROCESSING, 0, 1, { resumable: true }))) === json(['停止']) &&
                    buildResponseButtons(ButtonState.NONE, 0, 1, { resumable: true }) === undefined,
                'a running or button-less reply ignores it'
            );
        },
    },
    {
        name: 'the marks: only the marked latest version shows 继续; expired marks are not counted',
        body: async () => {
            const chatId = -1007300000001;
            const firstMessageId = takeMessageId();
            const versions = [{ versionId: 1 }, { versionId: 2 }];
            const before = state.countResumableReplies();
            state.markReplyResumable(chatId, firstMessageId, { versionId: 2, expiresAt: Date.now() + HOUR_MS });
            expect(state.countResumableReplies() === before + 1, 'a mark is counted');
            expect(state.showsResumableVersion(chatId, firstMessageId, versions, 1), 'the marked latest version shows it');
            expect(!state.showsResumableVersion(chatId, firstMessageId, versions, 0), 'an older version does not');
            expect(
                !state.showsResumableVersion(chatId, firstMessageId, [...versions, { versionId: 3 }], 1),
                'nor the marked one once a newer version exists'
            );
            state.clearReplyResumable(chatId, firstMessageId, 1);
            expect(state.resumableMarkOf(chatId, firstMessageId)?.versionId === 2, 'clearing another version leaves the mark');
            state.clearReplyResumable(chatId, firstMessageId);
            expect(state.resumableMarkOf(chatId, firstMessageId) === undefined, 'clearing without a version removes it');

            state.markReplyResumable(chatId, firstMessageId, { versionId: 1, expiresAt: Date.now() - 1 });
            expect(
                state.countResumableReplies() === before && !state.showsResumableVersion(chatId, firstMessageId, [{ versionId: 1 }], 0),
                'an expired mark counts for nothing'
            );
        },
    },
    {
        name: 'case 15: an entry expires after two hours, its mark with it, without any timer',
        body: async () => {
            let now = 1_000_000_000_000;
            const registry = createCheckpointRegistry({ now: () => now });
            const entry = entryOf(now);
            const prepared = registry.prepare(entry);
            if (prepared === null) throw new Error('a small entry was refused');
            quiet(() => registry.save(prepared));
            expect(registry.peek(entry.chatId, entry.firstMessageId)?.failedVersionId === 1, 'stored and readable');
            expect(markOf(entry) === 1, 'and the reply is marked');
            expect(
                state.resumableMarkOf(entry.chatId, entry.firstMessageId, now)?.expiresAt === now + CHECKPOINT_REGISTRY_LIMITS.ttlMs,
                'the mark runs out with the entry'
            );

            now += 2 * HOUR_MS - 1;
            expect(registry.peek(entry.chatId, entry.firstMessageId) !== undefined, 'still there just before two hours');
            now += 1;
            expect(quiet(() => registry.peek(entry.chatId, entry.firstMessageId)) === undefined, 'gone at two hours');
            expect(state.resumableMarkOf(entry.chatId, entry.firstMessageId, entry.savedAt) === undefined, 'and so is its mark');
            expect(registry.size() === 0, 'nothing left');
        },
    },
    {
        name: 'case 15: over ten entries the oldest goes and its mark is cleared',
        body: async () => {
            let now = 2_000_000_000_000;
            const registry = createCheckpointRegistry({ now: () => now });
            const entries: ReplyCheckpoint[] = [];
            for (let index = 0; index < 11; index += 1) {
                now += 1000;
                const entry = entryOf(now);
                entries.push(entry);
                const prepared = registry.prepare(entry);
                if (prepared === null) throw new Error('a small entry was refused');
                quiet(() => registry.save(prepared));
            }
            const [oldest, second] = entries;
            if (oldest === undefined || second === undefined) throw new Error('no entries');
            expect(registry.size() === CHECKPOINT_REGISTRY_LIMITS.maxEntries, `ten are kept (got ${registry.size()})`);
            expect(registry.peek(oldest.chatId, oldest.firstMessageId) === undefined, 'the oldest was evicted');
            expect(state.resumableMarkOf(oldest.chatId, oldest.firstMessageId, now) === undefined, 'its mark is cleared');
            expect(registry.peek(second.chatId, second.firstMessageId) !== undefined && markOf(second) === 1, 'the next one stays');
        },
    },
    {
        name: 'case 15: over the byte limit the oldest go; an entry bigger than the limit alone is never stored',
        body: async () => {
            let now = 3_000_000_000_000;
            const registry = createCheckpointRegistry({ now: () => now, limits: { maxBytes: 100_000 } });
            const first = entryOf((now += 1000), { loop: loopOfSize(40_000) });
            const second = entryOf((now += 1000), { loop: loopOfSize(40_000) });
            const third = entryOf((now += 1000), { loop: loopOfSize(40_000) });
            for (const entry of [first, second, third]) {
                const prepared = registry.prepare(entry);
                if (prepared === null) throw new Error('an entry under the limit was refused');
                quiet(() => registry.save(prepared));
            }
            expect(
                registry.peek(first.chatId, first.firstMessageId) === undefined &&
                    registry.peek(second.chatId, second.firstMessageId) !== undefined &&
                    registry.peek(third.chatId, third.firstMessageId) !== undefined,
                'the oldest went to make room'
            );
            expect(state.resumableMarkOf(first.chatId, first.firstMessageId, now) === undefined, 'its mark too');
            expect(registry.totalBytes() <= 100_000, `the sum stays under the limit (got ${registry.totalBytes()})`);

            const huge = entryOf((now += 1000), { loop: loopOfSize(120_000) });
            const refused = quiet(() => registry.prepare(huge));
            expect(refused === null, 'an entry over the limit alone is not prepared');
            expect(
                registry.peek(second.chatId, second.firstMessageId) !== undefined && registry.size() === 2,
                'and costs the others nothing'
            );
            expect(state.resumableMarkOf(huge.chatId, huge.firstMessageId, now) === undefined, 'it is never marked');

            const defaults = createCheckpointRegistry();
            const overDefault = entryOf(Date.now(), { loop: loopOfSize(64 * 1024 * 1024 + 1) });
            expect(quiet(() => defaults.prepare(overDefault)) === null, 'the default limit is 64 MB');
        },
    },
    {
        name: 'case 15: the stored journal keeps every chunk but only the last file and the last widget',
        body: async () => {
            const firstFile: StreamChunk = { type: 'file', file: { name: 'a.md', mimeType: 'text/markdown', data: Buffer.from('# a') } };
            const lastFile: StreamChunk = { type: 'file', file: { name: 'a.md', mimeType: 'text/markdown', data: Buffer.from('# a\n# b') } };
            const widget = (html: string): StreamChunk => ({
                type: 'widget',
                widget: { mode: 'html', html, htmlBytes: html.length, zlibBytes: html.length },
            });
            const sticker: StreamChunk = {
                type: 'sticker',
                sticker: { packIndex: 3, label: '猫', emoji: '🐱', fileId: 'f3', fileUniqueId: 'u3' },
            };
            const journal: StreamChunk[] = [
                { type: 'thinking', content: '想' },
                firstFile,
                widget('<p>1</p>'),
                { type: 'text', content: '写好了' },
                sticker,
                lastFile,
                widget('<p>2</p>'),
                { type: 'image', imageData: PNG_BYTES },
            ];
            const compacted = compactJournal(journal);
            expect(
                json(compacted.map((chunk) => chunk.type)) === json(['thinking', 'text', 'sticker', 'file', 'widget', 'image']),
                `order kept, earlier files and widgets dropped (got ${json(compacted.map((chunk) => chunk.type))})`
            );
            expect(compacted.includes(lastFile) && !compacted.includes(firstFile), 'the last file is the one kept');
            expect(compacted.find((chunk) => chunk.type === 'widget')?.widget?.html === '<p>2</p>', 'and the last widget');

            const registry = createCheckpointRegistry();
            const entry = entryOf(Date.now(), { loop: loopCheckpoint({ journal }) });
            const prepared = registry.prepare(entry);
            expect(prepared?.checkpoint.loop.journal.length === 6, 'the registry stores the compacted copy');
            expect(entry.loop.journal.length === 8, "the loop's own checkpoint is untouched");
        },
    },
    {
        name: 'case 15: a string or buffer shared between places is counted once',
        body: async () => {
            const base64 = 'A'.repeat(50_000);
            const buffer = Buffer.alloc(30_000);
            const single = estimateRetainedBytes([{ data: base64 }]);
            const twice = estimateRetainedBytes([{ data: base64 }, { again: base64, copy: `${base64.slice(0, 10)}${base64.slice(10)}` }]);
            expect(twice - single < 100, `the same base64 in two places costs it once (got ${single} vs ${twice})`);
            const oneBuffer = estimateRetainedBytes([buffer]);
            const sharedBuffer = estimateRetainedBytes([{ a: buffer, b: [buffer] }, buffer]);
            expect(sharedBuffer - oneBuffer < 100, `a shared buffer is counted once (got ${oneBuffer} vs ${sharedBuffer})`);
            const twoBuffers = estimateRetainedBytes([buffer, Buffer.alloc(30_000)]);
            expect(twoBuffers >= 60_000, `two different buffers are both counted (got ${twoBuffers})`);

            // The real case: the request contents and the context index carry the same picture
            const picture = { type: 'image', imageData: base64 };
            const entry = entryOf(Date.now(), { loop: loopCheckpoint({ state: { contents: [{ role: 'user', content: [picture] }] } }) });
            const withIndex: ReplyCheckpoint = {
                ...entry,
                context: {
                    ...entry.context,
                    contextIndex: new Map([[1, { number: 1, messageId: 9, fromBot: false, images: [{ origin: 'attachment', part: { type: 'image', imageData: base64 } }], imageCount: 1 }]]),
                },
            };
            const bytes = estimateCheckpointBytes(withIndex);
            expect(bytes >= 50_000 && bytes < 60_000, `the picture counts once across contents and index (got ${bytes})`);
            // A drawn picture sits in the media state and in the journal as the same buffer
            withIndex.toolState.media.generated.set('g1', { id: 'g1', data: buffer, mimeType: 'image/png' });
            const drawn: ReplyCheckpoint = { ...withIndex, loop: { ...withIndex.loop, journal: [{ type: 'image', imageData: buffer }] } };
            const drawnBytes = estimateCheckpointBytes(drawn);
            // 30 KB more, not 60: the media state and the journal share the buffer
            expect(drawnBytes - bytes > 29_000 && drawnBytes - bytes < 31_000, `and so does a drawn picture (got ${drawnBytes - bytes})`);
        },
    },
    {
        name: 'the estimate counts as V8 stores: CJK text two bytes a character, base64 and ASCII one, an object about 48 bytes',
        body: async () => {
            const chinese = estimateRetainedBytes(['中文的思考过程'.repeat(10_000)]);
            expect(chinese >= 2 * 70_000, `CJK text counts two bytes per character (got ${chinese} for 70000 characters)`);
            const ascii = estimateRetainedBytes(['plain ascii text'.repeat(10_000)]);
            expect(ascii >= 160_000 && ascii < 161_000, `ASCII counts one (got ${ascii} for 160000 characters)`);
            const base64 = Buffer.alloc(3 * 1024 * 1024, 7).toString('base64');
            const base64Bytes = estimateRetainedBytes([base64]);
            expect(base64Bytes === base64.length, `base64 counts one (got ${base64Bytes} for ${base64.length})`);
            // A bounded look decides, yet one spread over the string: a Chinese body after an ASCII start
            const mixed = `${'{"role":"user","text":"'.repeat(200)}${'很长的中文内容。'.repeat(20_000)}`;
            const mixedBytes = estimateRetainedBytes([mixed]);
            expect(mixedBytes === 2 * mixed.length, `a string that turns Chinese counts two (got ${mixedBytes} for ${mixed.length})`);
            expect(estimateRetainedBytes(['ü'.repeat(1000)]) === 1000, 'Latin-1 beyond ASCII still counts one');

            const count = 1000;
            const smallObjects = estimateRetainedBytes([Array.from({ length: count }, () => ({}))]);
            expect(smallObjects >= 48 * count, `${count} empty objects cost at least 48 bytes each (got ${smallObjects})`);
            const parts = estimateRetainedBytes([Array.from({ length: count }, (_unused, index) => ({ index, done: true }))]);
            expect(parts >= (48 + 16) * count, `and their fields come on top (got ${parts})`);
        },
    },
    {
        name: 'peek leaves the entry, take removes it with its mark, put back returns both, drop forgets them',
        body: async () => {
            const registry = createCheckpointRegistry();
            const entry = entryOf(Date.now(), { failedVersionId: 2 });
            const prepared = registry.prepare(entry);
            if (prepared === null) throw new Error('refused');
            quiet(() => registry.save(prepared));
            expect(registry.peek(entry.chatId, entry.firstMessageId) === prepared.checkpoint, 'peek reads');
            expect(registry.peek(entry.chatId, entry.firstMessageId) !== undefined, 'and leaves it');

            const taken = registry.take(entry.chatId, entry.firstMessageId);
            expect(taken === prepared.checkpoint, 'take hands it out');
            expect(registry.peek(entry.chatId, entry.firstMessageId) === undefined, 'it is gone');
            expect(state.resumableMarkOf(entry.chatId, entry.firstMessageId) === undefined, 'and the reply is no longer resumable');
            if (taken === undefined) throw new Error('nothing taken');

            registry.putBack(taken);
            expect(
                registry.peek(entry.chatId, entry.firstMessageId)?.failedVersionId === 2 &&
                    state.resumableMarkOf(entry.chatId, entry.firstMessageId)?.versionId === 2,
                'put back restores the entry and the mark'
            );
            expect(
                state.resumableMarkOf(entry.chatId, entry.firstMessageId)?.expiresAt === entry.savedAt + CHECKPOINT_REGISTRY_LIMITS.ttlMs,
                'with the lifetime it had'
            );
            const again = registry.take(entry.chatId, entry.firstMessageId);
            if (again === undefined) throw new Error('nothing taken');
            registry.putBack(again, { failedVersionId: 3 });
            expect(
                registry.peek(entry.chatId, entry.firstMessageId)?.failedVersionId === 3 &&
                    state.resumableMarkOf(entry.chatId, entry.firstMessageId)?.versionId === 3,
                'a put back onto a newer failed version marks that one'
            );

            registry.drop(entry.chatId, entry.firstMessageId);
            expect(
                registry.peek(entry.chatId, entry.firstMessageId) === undefined &&
                    state.resumableMarkOf(entry.chatId, entry.firstMessageId) === undefined,
                'drop forgets entry and mark'
            );
        },
    },
    {
        name: 'an entry whose mark is gone is dropped the next time the registry is touched; a second save replaces the first',
        body: async () => {
            const registry = createCheckpointRegistry();
            const entry = entryOf(Date.now());
            const prepared = registry.prepare(entry);
            if (prepared === null) throw new Error('refused');
            quiet(() => registry.save(prepared));
            // What a finalization of the reply does
            state.clearReplyResumable(entry.chatId, entry.firstMessageId);
            expect(registry.size() === 0, 'the next touch drops it');
            expect(registry.peek(entry.chatId, entry.firstMessageId) === undefined, 'nothing is handed out');

            const replaced = entryOf(Date.now(), { chatId: entry.chatId, failedVersionId: 1 });
            const sameKey = { ...replaced, firstMessageId: entry.firstMessageId };
            const firstSave = registry.prepare(sameKey);
            const secondSave = registry.prepare({ ...sameKey, failedVersionId: 2, loop: loopCheckpoint({ completedRounds: 4 }) });
            if (firstSave === null || secondSave === null) throw new Error('refused');
            quiet(() => registry.save(firstSave));
            quiet(() => registry.save(secondSave));
            const kept = registry.peek(entry.chatId, entry.firstMessageId);
            expect(
                registry.size() === 1 && kept?.failedVersionId === 2 && kept.loop.completedRounds === 4,
                `the later failure replaces the earlier entry (got ${json({ size: registry.size(), version: kept?.failedVersionId })})`
            );
        },
    },
    {
        name: 'case 18: why a checkpoint is missing: restart, expired, evicted',
        body: async () => {
            const processStartedAt = 5_000_000_000_000;
            const ttlMs = CHECKPOINT_REGISTRY_LIMITS.ttlMs;
            const reason = (failedVersionCreatedAt: number, now: number) =>
                checkpointMissingReason({ failedVersionCreatedAt, processStartedAt, now, ttlMs });
            expect(reason(processStartedAt - 1, processStartedAt + 1000) === 'restart', 'created before the process started');
            expect(reason(processStartedAt - 1, processStartedAt + 3 * ttlMs) === 'restart', 'a restart wins over the age');
            expect(reason(processStartedAt + 1000, processStartedAt + 1000 + ttlMs + 1) === 'expired', 'older than two hours');
            expect(reason(processStartedAt + 1000, processStartedAt + 2000) === 'evicted', 'anything else was pushed out');

            const registry = createCheckpointRegistry({ now: () => processStartedAt + 10_000, processStartedAt });
            expect(
                registry.missingReason(processStartedAt - 5) === 'restart' &&
                    registry.missingReason(processStartedAt + 5) === 'evicted',
                'the registry answers with its own start time and clock'
            );
            expect(
                createCheckpointRegistry().missingReason(performance.timeOrigin - 1) === 'restart',
                'by default the process start is the start time'
            );
        },
    },
    {
        name: 'canonical JSON sorts keys at every level and keeps array order',
        body: async () => {
            expect(
                canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: 'x' } }) === '{"a":{"c":"x","d":[3,{"x":2,"y":1}]},"b":1}',
                'sorted keys'
            );
            expect(canonicalJson([{ b: 1, a: 2 }, 1]) === '[{"a":2,"b":1},1]', 'arrays keep their order');
        },
    },
    {
        name: 'createReplyTools reuses an injected state bundle: g1 resolves, per-reply limits go on counting',
        body: async () => {
            const chatId = -1007300000050;
            const rootId = takeMessageId();
            const overrides = { image: true, imageReverseSearch: true, harnessIssues: true, workspace: true };
            const first = replyTools.createReplyTools('gemini-4-carbon', toolContextFor(chatId, [rootId]), undefined, overrides);
            const bundle = first.toolState;
            expect(first.workspaceState === bundle.workspace, 'the bundle carries the workspace state the manifest uses');

            // What the interrupted attempt left behind
            bundle.media.generated.set('g1', { id: 'g1', data: PNG_BYTES, mimeType: 'image/png' });
            bundle.media.reverseSearchCount = MAX_SEARCHES_PER_REPLY;
            for (let index = 0; index < MAX_HARNESS_ISSUES_PER_REPLY; index += 1) bundle.harnessIssues.noteCreated();
            bundle.workspace.calls.read = bundle.workspace.callLimits.reads;
            bundle.history.remember({
                channelId: 1,
                messageId: 77,
                timestamp: 0,
                fromId: null,
                fromName: '某人',
                fromIsBot: false,
                indexedHtml: '旧消息',
            });

            const resumed = replyTools.createReplyTools(
                'gemini-4-carbon',
                toolContextFor(chatId, [rootId]),
                undefined,
                overrides,
                'full',
                bundle
            );
            expect(resumed.toolState === bundle && resumed.workspaceState === bundle.workspace, 'the same objects are used');
            expect(resumed.toolState.history.entryOf(1)?.messageId === 77, 'the history numbering goes on (h1)');

            const run = (name: string, args: Record<string, unknown>) =>
                resumed.tools.execute({ id: `call-${name}`, name, argumentsJson: JSON.stringify(args) });
            const sent = await run('send_image', { image_id: 'g1' });
            expect(!sent.isError && sent.images[0]?.data === PNG_BYTES, `g1 still resolves (got ${sent.content})`);
            expect(bundle.media.hasReplyImage, 'and the attachment flag lands in the carried state');

            const reverse = await run('search_by_image', { message: 1 });
            expect(reverse.isError && reverse.content.includes(`${MAX_SEARCHES_PER_REPLY} 次以图搜图`), `search_by_image stays at its limit (got ${reverse.content})`);
            const issue = await run('create_harness_issue', { title: '标题', body: '内容', kind: 'bug' });
            expect(issue.isError && issue.content.includes(`${MAX_HARNESS_ISSUES_PER_REPLY} 条 issue`), `the issue limit carries on (got ${issue.content})`);
            const read = await run('workspace_read', { path: 'notes.md' });
            expect(read.isError && read.content.includes('次数已用完'), `the workspace read counter carries on (got ${read.content})`);

            // Without the bundle the next attempt starts from nothing
            const fresh = replyTools.createReplyTools('gemini-4-carbon', toolContextFor(chatId, [rootId]), undefined, overrides);
            const unknown = await fresh.tools.execute({ id: 'call', name: 'send_image', argumentsJson: JSON.stringify({ image_id: 'g1' }) });
            expect(fresh.toolState !== bundle && unknown.isError, 'a fresh reply does not know g1');
        },
    },
    {
        name: 'the search_by_image counter lives in the media state, so a new tool on the same state stays at the limit',
        body: async () => {
            const chatId = -1007300000051;
            const toolState = freshToolState(chatId);
            const searched: number[] = [];
            const dependencies = {
                search: async () => {
                    searched.push(1);
                    return {
                        ok: true as const,
                        cached: false,
                        result: { sites: [], sizes: [], similar: [], tags: [] },
                        stats: { elapsedMs: 1, uploadMs: 0, pageMs: 0 },
                    };
                },
                loadMessageImages: async () => [],
                loadAnimationFrame: async () => null,
                fetchImage: async () => ({ ok: false as const, error: 'offline' }),
            };
            toolState.media.fetched.set('img1', {
                id: 'img1',
                data: PNG_BYTES,
                mimeType: 'image/png',
                still: { data: PNG_BYTES, mimeType: 'image/png' },
                sourcePage: '',
                imageUrl: 'https://example.invalid/a.png',
            });
            const context = toolContextFor(chatId);
            const before = createSearchByImageTool({ state: toolState.media, context, dependencies });
            for (let index = 0; index < MAX_SEARCHES_PER_REPLY; index += 1) {
                const result = await quiet(() => before.execute({ image_id: 'img1' }, new AbortController().signal));
                expect(!result.isError, `search ${index + 1} runs (got ${result.content})`);
            }
            expect(toolState.media.reverseSearchCount === MAX_SEARCHES_PER_REPLY, 'counted in the state');
            const after = createSearchByImageTool({ state: toolState.media, context, dependencies });
            const refused = await after.execute({ image_id: 'img1' }, new AbortController().signal);
            expect(refused.isError && searched.length === MAX_SEARCHES_PER_REPLY, `the resumed tool refuses the next one (got ${refused.content})`);
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
