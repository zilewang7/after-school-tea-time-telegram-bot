/**
 * Offline cases for prompt templates (design 2026-1119-1146 v5 and
 * 2026-1119-1740 v6): the field rules and the model glob, the three-level
 * visibility and auto-candidate rules, composition (manual list ∪ auto
 * candidates, private templates only inside private chats, no rule = no auto
 * load), the service's CRUD and cache, `resolveReplyAddendum`, the panel's
 * template routes and the chat's two settings keys, the settings preview, the
 * reply path the model request goes through, and the chat_settings migration.
 *
 * Run: npx tsx scripts/offline/prompt-templates.mts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammyError } from 'grammy';
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import {
    contextOf,
    createFakeTelegram,
    endOpenReplies,
    messageUpdate,
    quietly,
    startChatCompletionStub,
} from './fake-telegram.mts';
import { startStubServer } from './support/stub-server.mts';
import { signInitData, type InitDataUserInput } from '../lib/init-data.mts';

const BOT_TOKEN = '424242:AAFakeOfflineTokenForPromptTemplateTests';
const OWNER_ID = 4242;
const OWNER: InitDataUserInput = { id: OWNER_ID, first_name: 'Owner' };
const ALICE: InitDataUserInput = { id: 5001, first_name: 'Alice' };
const BOB: InitDataUserInput = { id: 5002, first_name: 'Bob' };
const CAROL: InitDataUserInput = { id: 5003, first_name: 'Carol' };

/** Alice and Bob are members; Alice is a known member (chat_members_seen) */
const GROUP_MAIN = -1001000000001;
/** Bob is a member, Alice is not: another user's group template stays hidden there */
const GROUP_OTHER = -1001000000002;
/** Alice's group for the two settings keys and their audit */
const GROUP_AUDIT = -1001000000003;
/** Alice's group for the 8000-code-point save guard */
const GROUP_BUDGET = -1001000000004;
/** Alice's group for the lock rule */
const GROUP_LOCK = -1001000000005;
/** Alice is not a member: every single-chat endpoint must refuse her */
const GROUP_LEFT = -1001000000006;
/** A chat with no saved settings, for the preview's empty-body default */
const GROUP_PREVIEW = -1001000000007;

// Read once by the config layer, before src is imported
process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.DEFAULT_MODEL = 'env-default-model';
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
delete process.env.ALLOWED_CHAT_IDS;

// The reply case talks to a MiMo-shaped stub; the platform reads its URL once,
// when the platforms are created
const mimoStubServer = await startStubServer();
process.env.MIMO_API_URL = `${mimoStubServer.url}/v1`;
process.env.MIMO_API_KEY = 'offline-stub';

await setupOfflineDb();

const rules = await import('../../src/services/prompt-template-rules.js');
const templateIds = await import('../../src/services/prompt-template-ids.js');
const visibility = await import('../../src/services/prompt-template-visibility.js');
const cache = await import('../../src/services/prompt-templates-cache.js');
const templatesService = await import('../../src/services/prompt-templates-service.js');
const settingsService = await import('../../src/services/chat-settings-service.js');
const { ChatMemberSeen } = await import('../../src/db/chatMemberSeenDTO.js');
const { PromptTemplateRecord } = await import('../../src/db/promptTemplateDTO.js');
const { listSettingsAudit } = await import('../../src/db/queries/settings-audit.js');
const registry = await import('../../src/db/queries/panel-registry.js');
const { createPanelApp } = await import('../../src/panel/app.js');
const dbIndex = await import('../../src/db/index.js');
const { handleReply } = await import('../../src/reply/chat-handler.js');
const { sequelize } = await import('../../src/db/config.js');
const { runSchemaMigrations } = await import('../../src/db/schema-migrations.js');
const { QueryTypes } = await import('@sequelize/core');

type PromptTemplate = import('../../src/services/prompt-templates-cache.js').PromptTemplate;
type PromptTemplateVisibility = import('../../src/services/prompt-template-rules.js').PromptTemplateVisibility;
type AutoCandidatesContext = import('../../src/services/prompt-template-rules.js').AutoCandidatesContext;
type AddendumChatContext = import('../../src/services/prompt-template-rules.js').AddendumChatContext;
type AutoCandidateContext = import('../../src/services/prompt-template-rules.js').AutoCandidateContext;
type SettingsActor = import('../../src/services/settings-errors.js').SettingsActor;
type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;
type PanelApp = ReturnType<typeof createPanelApp>;

// ---- json helpers (no casts: every value is narrowed) -----------------------

type JsonObject = Record<string, unknown>;

const objectOf = (value: unknown): JsonObject =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

const arrayOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const numberOf = (value: unknown): number | null => (typeof value === 'number' ? value : null);

const nullableNumberListOf = (value: unknown): number[] | null =>
    value === null ? null : arrayOf(value).map((entry) => numberOf(entry) ?? -1);

const jsonOf = async (response: Response): Promise<JsonObject> => {
    const text = await response.text();
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { notJson: text };
    }
    return objectOf(parsed);
};

interface ErrorView {
    code: string;
    message: string;
}

const errorOf = (body: JsonObject): ErrorView => {
    const error = objectOf(body.error);
    return { code: textOf(error.code) ?? '-', message: textOf(error.message) ?? '' };
};

const jsonOfText = (value: unknown): string => JSON.stringify(value);

/** The column names of a table, as sqlite reports them */
const columnsOf = async (table: string): Promise<string[]> => {
    const rows: unknown[] = await sequelize.query(`PRAGMA table_info(${table})`, { type: QueryTypes.SELECT });
    return rows.flatMap((row) => {
        if (typeof row !== 'object' || row === null) return [];
        const name: unknown = Object.fromEntries(Object.entries(row)).name;
        return typeof name === 'string' ? [name] : [];
    });
};

// ---- prompt-template views of the panel JSON -------------------------------

interface TemplateItemView {
    id: number;
    name: string;
    contentLength: number;
    contentPreview: string;
    modelPatterns: string[];
    sortOrder: number;
    visibility: string;
    enabled: boolean;
    createdBy: number;
    createdByName: string;
    chatCount: number;
    updatedAt: string;
}

interface TemplateDetailView extends TemplateItemView {
    content: string;
    createdAt: string;
}

interface ChatTemplateItemView extends TemplateItemView {
    enabledInChat: boolean;
    autoMatchesViewerModel: boolean;
}

interface SettingsView {
    promptTemplateIds: number[] | null;
    promptTemplatesAuto: boolean;
}

interface AppliedTemplateView {
    id: number;
    name: string;
}

interface PreviewView {
    runtimeBlock: string;
    appliedTemplates: AppliedTemplateView[];
    composedCodePoints: number;
    estimatedTokens: number;
    injected: boolean;
}

const templateItemOf = (value: unknown): TemplateItemView => {
    const item = objectOf(value);
    return {
        id: numberOf(item.id) ?? -1,
        name: textOf(item.name) ?? '',
        contentLength: numberOf(item.contentLength) ?? -1,
        contentPreview: textOf(item.contentPreview) ?? '',
        modelPatterns: arrayOf(item.modelPatterns).map((pattern) => textOf(pattern) ?? ''),
        sortOrder: numberOf(item.sortOrder) ?? -1,
        visibility: textOf(item.visibility) ?? '',
        enabled: item.enabled === true,
        createdBy: numberOf(item.createdBy) ?? -1,
        createdByName: textOf(item.createdByName) ?? '',
        chatCount: numberOf(item.chatCount) ?? -1,
        updatedAt: textOf(item.updatedAt) ?? '',
    };
};

const templateDetailOf = (value: unknown): TemplateDetailView => {
    const template = templateItemOf(value);
    const detail = objectOf(value);
    return {
        ...template,
        content: textOf(detail.content) ?? '',
        createdAt: textOf(detail.createdAt) ?? '',
    };
};

const chatTemplateItemOf = (value: unknown): ChatTemplateItemView => {
    const item = templateItemOf(value);
    const chatItem = objectOf(value);
    return {
        ...item,
        enabledInChat: chatItem.enabledInChat === true,
        autoMatchesViewerModel: chatItem.autoMatchesViewerModel === true,
    };
};

const templateListOf = (body: JsonObject): TemplateItemView[] =>
    arrayOf(body.templates).map(templateItemOf);

const chatTemplateListOf = (body: JsonObject): ChatTemplateItemView[] =>
    arrayOf(body.templates).map(chatTemplateItemOf);

const itemNamed = (items: readonly ChatTemplateItemView[], name: string): ChatTemplateItemView => {
    const found = items.find((item) => item.name === name);
    if (found === undefined) throw new Error(`template ${name} is not in the list`);
    return found;
};

const appliedTemplatesOf = (value: unknown): AppliedTemplateView[] =>
    arrayOf(value).map((entry) => {
        const item = objectOf(entry);
        return { id: numberOf(item.id) ?? -1, name: textOf(item.name) ?? '' };
    });

const settingsOf = (value: unknown): SettingsView => {
    const settings = objectOf(value);
    return {
        promptTemplateIds: nullableNumberListOf(settings.promptTemplateIds),
        promptTemplatesAuto: settings.promptTemplatesAuto === true,
    };
};

const previewOf = (value: unknown): PreviewView => {
    const preview = objectOf(value);
    return {
        runtimeBlock: textOf(preview.runtimeBlock) ?? '',
        appliedTemplates: appliedTemplatesOf(preview.appliedTemplates),
        composedCodePoints: numberOf(preview.composedCodePoints) ?? -1,
        estimatedTokens: numberOf(preview.estimatedTokens) ?? -1,
        injected: preview.injected === true,
    };
};

const namesOf = (applied: readonly AppliedTemplateView[]): string[] => applied.map((template) => template.name);

const namesByItem = (items: readonly TemplateItemView[]): string[] => items.map((item) => item.name);

const codePoints = (text: string): number => Array.from(text).length;

// ---- pure template fixtures -------------------------------------------------

interface SyntheticTemplateInput {
    id: number;
    name: string;
    content: string;
    modelPatterns?: readonly string[];
    sortOrder?: number;
    visibility?: PromptTemplateVisibility;
    enabled?: boolean;
    createdBy?: number;
}

/** A template as the composer sees it, without touching the database */
const syntheticTemplate = (input: SyntheticTemplateInput): PromptTemplate => ({
    id: input.id,
    name: input.name,
    content: input.content,
    modelPatterns: input.modelPatterns ?? [],
    sortOrder: input.sortOrder ?? 0,
    visibility: input.visibility ?? 'private',
    enabled: input.enabled ?? true,
    createdBy: input.createdBy ?? ALICE.id,
    createdAt: new Date(0),
    updatedAt: new Date(0),
});

/** The chat context of a reply in a group chat */
const GROUP_CHAT: AddendumChatContext = { privateChatUserId: null, ownerId: OWNER_ID };
/** The chat context of a reply in Alice's private chat */
const ALICE_PRIVATE_CHAT: AddendumChatContext = { privateChatUserId: ALICE.id, ownerId: OWNER_ID };
/** The chat context of a reply in Bob's private chat */
const BOB_PRIVATE_CHAT: AddendumChatContext = { privateChatUserId: BOB.id, ownerId: OWNER_ID };
/** The chat context of a reply in the owner's private chat */
const OWNER_PRIVATE_CHAT: AddendumChatContext = { privateChatUserId: OWNER_ID, ownerId: OWNER_ID };

// ---- service-side fixtures --------------------------------------------------

const ownerActor: SettingsActor = { userId: OWNER_ID, isOwner: true };
const aliceActor: SettingsActor = { userId: ALICE.id, isOwner: false };
const bobActor: SettingsActor = { userId: BOB.id, isOwner: false };
const carolActor: SettingsActor = { userId: CAROL.id, isOwner: false };

const memberSeenNow = new Date();
await ChatMemberSeen.create({
    chatId: GROUP_MAIN,
    userId: ALICE.id,
    firstSeenAt: memberSeenNow,
    lastSeenAt: memberSeenNow,
    messageCount: 3,
});

await registry.upsertChatNow({ id: GROUP_MAIN, type: 'supergroup', title: 'Main' });
await registry.upsertChatNow({ id: GROUP_OTHER, type: 'supergroup', title: 'Other' });
await registry.upsertChatNow({ id: GROUP_AUDIT, type: 'supergroup', title: 'Audit' });
await registry.upsertChatNow({ id: GROUP_BUDGET, type: 'supergroup', title: 'Budget' });
await registry.upsertChatNow({ id: GROUP_LOCK, type: 'supergroup', title: 'Lock' });
await registry.upsertChatNow({ id: GROUP_LEFT, type: 'supergroup', title: 'Left' });
await registry.upsertChatNow({ id: GROUP_PREVIEW, type: 'supergroup', title: 'Preview' });
await settingsService.loadChatSettingsCache();

const ownerGroupTemplate = await templatesService.createPromptTemplate(
    {
        name: '机主公用模板',
        content: '机主公用内容',
        modelPatterns: ['viewer-model*'],
        sortOrder: 10,
        visibility: 'group',
        enabled: true,
    },
    ownerActor
);
const ownerPrivateTemplate = await templatesService.createPromptTemplate(
    {
        name: '机主私有模板',
        content: '机主私有内容',
        modelPatterns: ['viewer-model*'],
        sortOrder: 55,
        visibility: 'private',
        enabled: true,
    },
    ownerActor
);
const aliceGroupTemplate = await templatesService.createPromptTemplate(
    {
        name: 'Alice 群可见模板',
        content: 'Alice 群可见内容',
        modelPatterns: ['viewer-model*'],
        sortOrder: 20,
        visibility: 'group',
        enabled: true,
    },
    aliceActor
);
const aliceOtherModelTemplate = await templatesService.createPromptTemplate(
    {
        name: 'Alice 其他模型模板',
        content: 'Alice 其他模型内容',
        modelPatterns: ['other-model*'],
        sortOrder: 30,
        visibility: 'group',
        enabled: true,
    },
    aliceActor
);
const aliceDisabledTemplate = await templatesService.createPromptTemplate(
    {
        name: 'Alice 停用模板',
        content: 'Alice 停用内容',
        modelPatterns: ['viewer-model*'],
        sortOrder: 40,
        visibility: 'group',
        enabled: false,
    },
    aliceActor
);
const alicePrivateTemplate = await templatesService.createPromptTemplate(
    {
        name: 'Alice 私有模板',
        content: 'Alice 私有内容',
        modelPatterns: ['viewer-model*'],
        sortOrder: 50,
        visibility: 'private',
        enabled: true,
    },
    aliceActor
);
const bobGroupTemplate = await templatesService.createPromptTemplate(
    {
        name: 'Bob 群可见模板',
        content: 'Bob 群可见内容',
        modelPatterns: ['viewer-model*'],
        sortOrder: 60,
        visibility: 'group',
        enabled: true,
    },
    bobActor
);
const aliceGlobalTemplate = await templatesService.createPromptTemplate(
    {
        name: 'Alice 全局模板',
        content: 'Alice 全局内容',
        modelPatterns: ['viewer-model*'],
        sortOrder: 70,
        visibility: 'global',
        enabled: true,
    },
    aliceActor
);
const aliceNoRuleTemplate = await templatesService.createPromptTemplate(
    {
        name: 'Alice 空规则模板',
        content: 'Alice 空规则内容',
        modelPatterns: [],
        sortOrder: 80,
        visibility: 'global',
        enabled: true,
    },
    aliceActor
);
const bobGlobalTemplate = await templatesService.createPromptTemplate(
    {
        name: 'Bob 全局模板',
        content: 'Bob 全局内容',
        modelPatterns: ['viewer-model*'],
        sortOrder: 90,
        visibility: 'global',
        enabled: true,
    },
    bobActor
);

// ---- panel app --------------------------------------------------------------

const staticRoot = mkdtempSync(join(tmpdir(), 'k-on-bot-prompt-templates-'));
process.once('exit', () => rmSync(staticRoot, { recursive: true, force: true }));

/** A member answer for the group chat ids above; everything else is "not found" */
const memberships = new Map<string, 'member'>([
    [`${GROUP_MAIN}:${ALICE.id}`, 'member'],
    [`${GROUP_MAIN}:${BOB.id}`, 'member'],
    [`${GROUP_OTHER}:${BOB.id}`, 'member'],
    [`${GROUP_AUDIT}:${ALICE.id}`, 'member'],
    [`${GROUP_BUDGET}:${ALICE.id}`, 'member'],
    [`${GROUP_LOCK}:${ALICE.id}`, 'member'],
    [`${GROUP_PREVIEW}:${ALICE.id}`, 'member'],
]);

const fakeMembership: MembershipLookup = async (chatId, userId) => {
    if (memberships.get(`${chatId}:${userId}`) === 'member') return { status: 'member' };
    throw new GrammyError(
        '(400: Bad Request: user not found)',
        { ok: false, error_code: 400, description: 'Bad Request: user not found' },
        'getChatMember',
        {}
    );
};

const app: PanelApp = createPanelApp({
    botToken: BOT_TOKEN,
    membershipLookup: fakeMembership,
    staticRoot,
    startedAt: new Date('2026-11-19T00:00:00.000Z'),
    version: 'offline',
    // The cases below send more requests than the production per-minute budget
    rateLimit: { limit: 1000, windowMs: 60_000 },
});

interface CallOptions {
    method?: string;
    user?: InitDataUserInput;
    body?: unknown;
    rawBody?: string;
}

const initDataFor = (user: InitDataUserInput): string =>
    signInitData({ botToken: BOT_TOKEN, user, authDate: Math.floor(Date.now() / 1000) });

const call = (path: string, options: CallOptions = {}): Promise<Response> => {
    const headers = new Headers();
    if (options.user !== undefined) headers.set('X-Init-Data', initDataFor(options.user));
    let body: string | undefined;
    if (options.rawBody !== undefined) body = options.rawBody;
    else if (options.body !== undefined) body = JSON.stringify(options.body);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    return Promise.resolve(app.request(path, { method: options.method ?? 'GET', headers, body }));
};

const getJson = async (path: string, options: CallOptions = {}): Promise<JsonObject> =>
    jsonOf(await call(path, options));

const expectError = async (
    response: Response,
    status: number,
    code: string,
    label: string
): Promise<void> => {
    const body = await jsonOf(response);
    const actual = errorOf(body);
    expect(
        response.status === status && actual.code === code,
        `${label} → ${status} ${code} (got ${response.status} ${actual.code} ${actual.message})`
    );
};

/** The ChatSettingsError code `run` throws, or 'none' */
const rejectionOf = async (run: () => Promise<unknown>): Promise<string> => {
    try {
        await run();
        return 'none';
    } catch (error) {
        if (error instanceof settingsService.ChatSettingsError) return error.code;
        throw error;
    }
};

/** The ChatSettingsError `run` throws as `code: message`, or 'none' */
const refusalOf = async (run: () => Promise<unknown>): Promise<string> => {
    try {
        await run();
        return 'none';
    } catch (error) {
        if (error instanceof settingsService.ChatSettingsError) return `${error.code}: ${error.message}`;
        throw error;
    }
};

/** Collect the console lines of `body` and put the console back afterwards */
const logsOf = async (body: () => Promise<void>): Promise<string[]> => {
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...parts: unknown[]): void => {
        lines.push(parts.map(String).join(' '));
    };
    console.warn = (...parts: unknown[]): void => {
        lines.push(parts.map(String).join(' '));
    };
    console.error = (...parts: unknown[]): void => {
        lines.push(parts.map(String).join(' '));
    };
    try {
        await body();
        return lines;
    } finally {
        console.log = original.log;
        console.warn = original.warn;
        console.error = original.error;
    }
};

// ---- normalization result helpers ------------------------------------------

type TemplateFieldNormalizationOf<T> =
    import('../../src/services/prompt-template-rules.js').TemplateFieldNormalization<T>;

const normalizedValueOf = <T,>(normalized: TemplateFieldNormalizationOf<T>): T | undefined =>
    normalized.ok ? normalized.value : undefined;

const normalizedMessageOf = (normalized: TemplateFieldNormalizationOf<unknown>): string =>
    normalized.ok ? '' : normalized.message;

const idListValueOf = (
    normalized: import('../../src/services/prompt-template-ids.js').TemplateIdListNormalization
): number[] | null | undefined => (normalized.ok ? normalized.value : undefined);

const isRefused = (normalized: TemplateFieldNormalizationOf<unknown>): boolean => !normalized.ok;

// ---- cases ------------------------------------------------------------------

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'template names: trimmed, 1–40 code points, no newline or control character',
        body: async () => {
            const name = rules.normalizeTemplateName;
            expect(normalizedValueOf(name('  机主  ')) === '机主', 'a name is trimmed');
            expect(normalizedValueOf(name('a'.repeat(40))) === 'a'.repeat(40), '40 ASCII characters fit');
            expect(
                normalizedValueOf(name('😀'.repeat(40))) === '😀'.repeat(40),
                '40 astral code points fit although they are 80 UTF-16 units'
            );
            expect(isRefused(name('')), 'an empty name is refused');
            expect(isRefused(name('   ')), 'a blank name is refused');
            expect(isRefused(name('a'.repeat(41))), '41 characters are refused');
            expect(isRefused(name('😀'.repeat(41))), '41 astral code points are refused');
            expect(isRefused(name('两行\n名字')), 'a newline is refused');
            expect(isRefused(name('制表\t符')), 'a tab is refused in a name');
            expect(isRefused(name('控制\u0001符')), 'a C0 control character is refused');
            expect(isRefused(name('删除\u007f符')), 'DEL is refused');
            expect(isRefused(name(42)), 'a non-string is refused');
            const message = normalizedMessageOf(name(''));
            expect(message.includes('1–40'), `the message names the length range (got ${message})`);
            const controlMessage = normalizedMessageOf(name('两行\n名字'));
            expect(controlMessage.includes('换行'), `the message names the newline (got ${controlMessage})`);
        },
    },
    {
        name: 'template content: CRLF becomes LF, trimmed, 1–4000 code points, control characters refused',
        body: async () => {
            const content = rules.normalizeTemplateContent;
            expect(
                normalizedValueOf(content('\r\n 第一行\r\n第二行 \r\n')) === '第一行\n第二行',
                `CRLF becomes LF and the text is trimmed (got ${jsonOfText(normalizedValueOf(content('\r\n 第一行\r\n第二行 \r\n')))})`
            );
            expect(
                normalizedValueOf(content('  a\tb  ')) === 'a\tb',
                'a tab is allowed between characters'
            );
            expect(normalizedValueOf(content('😀'.repeat(4000))) === '😀'.repeat(4000), '4000 astral code points fit');
            expect(isRefused(content('')), 'empty content is refused');
            expect(isRefused(content('\r\n  \t ')), 'content that is only whitespace is refused');
            expect(isRefused(content('😀'.repeat(4001))), '4001 astral code points are refused');
            expect(isRefused(content('前\u0000后')), 'NUL is refused');
            expect(isRefused(content('前\u001f后')), 'a C0 control character is refused');
            expect(isRefused(content('前\u007f后')), 'DEL is refused');
            expect(isRefused(content('前\uFFFE后')), 'U+FFFE is refused');
            expect(isRefused(content('前\uFFFF后')), 'U+FFFF is refused');
            expect(isRefused(content(42)), 'a non-string is refused');
            const controlMessage = normalizedMessageOf(content('前\u0001后'));
            expect(controlMessage.includes('不支持的字符'), `the control message says so (got ${controlMessage})`);
            const lengthMessage = normalizedMessageOf(content('a'.repeat(4001)));
            expect(lengthMessage.includes('4000'), `the length message names 4000 (got ${lengthMessage})`);
        },
    },
    {
        name: 'loading rules: trimmed and lowercased, blanks dropped, duplicates merged, 20 of at most 64 characters',
        body: async () => {
            const patterns = rules.normalizeModelPatterns;
            expect(
                jsonOfText(normalizedValueOf(patterns([' DeepSeek* ', '', 'deepseek*', 'Gemini-4-*']))) ===
                    jsonOfText(['deepseek*', 'gemini-4-*']),
                'rules are trimmed, lowercased, de-duplicated and blank entries dropped'
            );
            expect(jsonOfText(normalizedValueOf(patterns([]))) === '[]', 'an empty list is a valid "no loading rule"');
            expect(
                normalizedValueOf(patterns(Array.from({ length: 20 }, (_, index) => `m${index}*`)))?.length === 20,
                '20 rules fit'
            );
            expect(
                isRefused(patterns(Array.from({ length: 21 }, (_, index) => `m${index}*`))),
                '21 rules are refused'
            );
            expect(normalizedValueOf(patterns(['a'.repeat(64)]))?.[0] === 'a'.repeat(64), 'a 64-character rule fits');
            expect(isRefused(patterns(['a'.repeat(65)])), 'a 65-character rule is refused');
            expect(isRefused(patterns(['a b'])), 'whitespace inside a rule is refused');
            expect(isRefused(patterns(['a\tb'])), 'a tab inside a rule is refused');
            expect(isRefused(patterns('deepseek*')), 'a non-array is refused');
            expect(isRefused(patterns([42])), 'a non-string rule is refused');
            expect(jsonOfText(normalizedValueOf(patterns(['a*', 'b*']))) === jsonOfText(['a*', 'b*']), 'order is kept');

            const canonical = rules.canonicalModelPatternsJson(['deepseek*', 'gemini-4-*']);
            expect(canonical === '["deepseek*","gemini-4-*"]', `canonical JSON (got ${canonical})`);
            expect(
                jsonOfText(rules.parseStoredModelPatterns(canonical)) === jsonOfText(['deepseek*', 'gemini-4-*']),
                'the canonical form parses back'
            );
            expect(rules.parseStoredModelPatterns('not json') === null, 'unparsable stored rules are null');
            expect(rules.parseStoredModelPatterns('{"a":1}') === null, 'a stored non-array is null');
            expect(rules.parseStoredModelPatterns('["a b"]') === null, 'stored invalid rules are null');
        },
    },
    {
        name: 'visibility and sort order: the three visibility values, an integer 0–100000, absent means 0',
        body: async () => {
            expect(normalizedValueOf(rules.normalizeTemplateVisibility('global')) === 'global', 'global is accepted');
            expect(normalizedValueOf(rules.normalizeTemplateVisibility('private')) === 'private', 'private is accepted');
            expect(normalizedValueOf(rules.normalizeTemplateVisibility('group')) === 'group', 'group is accepted');
            expect(isRefused(rules.normalizeTemplateVisibility('public')), 'public is refused');
            expect(isRefused(rules.normalizeTemplateVisibility(null)), 'null is refused');
            expect(isRefused(rules.normalizeTemplateVisibility(42)), 'a number is refused');
            const visibilityMessage = normalizedMessageOf(rules.normalizeTemplateVisibility('public'));
            expect(
                visibilityMessage.includes('全局可见') && visibilityMessage.includes('完全隐藏'),
                `the message names the three choices (got ${visibilityMessage})`
            );

            const sortOrder = rules.normalizeSortOrder;
            expect(normalizedValueOf(sortOrder(undefined)) === 0, 'absent means 0');
            expect(normalizedValueOf(sortOrder(null)) === 0, 'null means 0');
            expect(normalizedValueOf(sortOrder(0)) === 0, '0 fits');
            expect(normalizedValueOf(sortOrder(100000)) === 100000, '100000 fits');
            expect(isRefused(sortOrder(-1)), '-1 is refused');
            expect(isRefused(sortOrder(100001)), '100001 is refused');
            expect(isRefused(sortOrder(1.5)), 'a fractional order is refused');
            expect(isRefused(sortOrder('3')), 'a string order is refused');
            const sortMessage = normalizedMessageOf(sortOrder(-1));
            expect(sortMessage.includes('0–100000'), `the sort message names the range (got ${sortMessage})`);

            expect(normalizedValueOf(rules.normalizeTemplateEnabled(true)) === true, 'enabled true is accepted');
            expect(normalizedValueOf(rules.normalizeTemplateEnabled(false)) === false, 'enabled false is accepted');
            expect(isRefused(rules.normalizeTemplateEnabled('true')), 'a string enabled flag is refused');
        },
    },
    {
        name: 'modelMatchesPattern: whole-string, case-insensitive, * the only wildcard, other metacharacters literal',
        body: async () => {
            const matches = rules.modelMatchesPattern;
            expect(matches('deepseek*', 'deepseek-flash'), 'a suffix wildcard matches');
            expect(!matches('deepseek', 'deepseek-flash'), 'without a wildcard the whole id must match');
            expect(matches('*flash', 'deepseek-flash'), 'a prefix wildcard matches');
            expect(matches('*', 'anything-at-all'), '* alone matches every id');
            expect(matches('*flash*', 'deepseek-flash'), 'wildcards on both sides match');
            expect(matches('DEEPSEEK*', 'deepseek-flash'), 'matching is case-insensitive');
            expect(matches('gpt-6.2-sol', 'gpt-6.2-sol'), 'a dot is a literal dot, not a regex wildcard');
            expect(!matches('gpt-6.2-sol', 'gpt-6X2-sol'), 'so it does not match another character');
            expect(matches('a+b', 'a+b'), 'a plus is literal');
            expect(!matches('a+b', 'aab'), 'and does not repeat the previous character');
            expect(matches('[x]', '[x]'), 'brackets are literal');
            expect(!matches('[x]', 'x'), 'and do not form a character class');
            expect(matches('(a|b)', '(a|b)'), 'parentheses are literal and do not throw');
            expect(!matches('(a|b)', 'a'), 'and do not group alternatives');

            expect(!rules.templateMatchesModel({ modelPatterns: [] }, 'whatever'), 'no rule matches no model: null rule means manual-only');
            expect(rules.templateMatchesModel({ modelPatterns: ['*'] }, 'whatever'), 'an explicit * matches every model');
            expect(rules.templateMatchesModel({ modelPatterns: ['m1*'] }, 'm1-x'), 'a rule that matches loads');
            expect(
                rules.templateMatchesModel({ modelPatterns: ['zzz*', 'm1*'] }, 'm1-x'),
                'any of the rules may match'
            );
            expect(!rules.templateMatchesModel({ modelPatterns: ['zzz*'] }, 'm1-x'), 'no matching rule does not load');
        },
    },
    {
        name: 'template id lists: null or positive unique ids ascending, at most 10; canonical JSON round-trips',
        body: async () => {
            const normalize = templateIds.normalizeTemplateIdList;
            expect(idListValueOf(normalize(null)) === null, 'null means none');
            expect(idListValueOf(normalize([])) === null, 'an empty list means none');
            expect(jsonOfText(idListValueOf(normalize([5, 2, 2]))) === jsonOfText([2, 5]), 'ids are de-duplicated and ascending');
            expect(
                idListValueOf(normalize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))?.length === 10,
                '10 ids fit'
            );
            expect(
                idListValueOf(normalize(Array.from({ length: 11 }, (_, index) => index + 1))) === undefined,
                '11 ids are refused'
            );
            for (const value of [0, -1, 1.5, '3', Number.NaN, Number.POSITIVE_INFINITY]) {
                expect(idListValueOf(normalize([value])) === undefined, `the id ${String(value)} is refused`);
            }
            expect(idListValueOf(normalize(5)) === undefined, 'a bare number is refused');
            const message = normalize([0]);
            expect(message.ok === false && message.message.includes('最多 10'), 'the message names the limit');

            expect(templateIds.canonicalTemplateIdListJson([2, 5]) === '[2,5]', 'the canonical form is sorted JSON');
            expect(templateIds.canonicalTemplateIdListJson(null) === null, 'none is stored as NULL');
            expect(templateIds.templateIdListEqual([2, 5], [2, 5]), 'equal lists compare equal');
            expect(!templateIds.templateIdListEqual([2, 5], [5, 2]), 'a different order is a different stored text');
            expect(!templateIds.templateIdListEqual(null, []), 'NULL and an empty array are not equal');
            expect(jsonOfText(templateIds.parseStoredTemplateIdList('[2,5]')) === jsonOfText([2, 5]), 'a stored list parses');
            expect(templateIds.parseStoredTemplateIdList('null') === null, 'stored JSON null reads as none');
            expect(templateIds.parseStoredTemplateIdList('not json') === null, 'unparsable stored text reads as none');
            expect(templateIds.parseStoredTemplateIdList('[0]') === null, 'a stored invalid list reads as none');
            expect(
                jsonOfText(templateIds.parseStoredTemplateIdList(templateIds.canonicalTemplateIdListJson([3, 1]))) ===
                    jsonOfText([1, 3]),
                'canonical JSON round-trips through the parser'
            );
        },
    },
    {
        name: 'visibility: global is visible to everyone, group follows the creator, private only inside a private chat',
        body: async () => {
            const globalTemplate = syntheticTemplate({
                id: 1,
                name: 'global',
                content: 'x',
                createdBy: CAROL.id,
                visibility: 'global',
            });
            const ownerGroup = syntheticTemplate({
                id: 2,
                name: 'owner-group',
                content: 'x',
                createdBy: OWNER_ID,
                visibility: 'group',
            });
            const aliceGroup = syntheticTemplate({
                id: 3,
                name: 'alice-group',
                content: 'x',
                createdBy: ALICE.id,
                visibility: 'group',
            });
            const alicePrivate = syntheticTemplate({
                id: 4,
                name: 'alice-private',
                content: 'x',
                createdBy: ALICE.id,
                visibility: 'private',
            });
            const visibleIn = (viewerId: number, isOwner: boolean, knownMemberIds: number[], isPrivateChat: boolean) => ({
                viewerId,
                isOwner,
                knownMemberIds: new Set(knownMemberIds),
                isPrivateChat,
            });

            // global: listed everywhere, whoever its creator is
            expect(visibility.isTemplateVisible(globalTemplate, visibleIn(BOB.id, false, [], false)), 'global in a group: visible');
            expect(visibility.isTemplateVisible(globalTemplate, visibleIn(BOB.id, false, [], true)), 'global in a private chat: visible');
            expect(visibility.isTemplateVisible(globalTemplate, visibleIn(OWNER_ID, true, [], false)), 'global to the owner: visible');

            // group: the owner's is a public library; another creator's needs them to be a known member
            expect(
                visibility.isTemplateVisible(ownerGroup, visibleIn(ALICE.id, false, [], false)),
                "the owner's group template in a group: visible"
            );
            expect(
                visibility.isTemplateVisible(ownerGroup, visibleIn(ALICE.id, false, [], true)),
                "the owner's group template is the public library: visible in another user's private chat too"
            );
            expect(
                visibility.isTemplateVisible(ownerGroup, visibleIn(OWNER_ID, true, [], true)),
                'its creator (the owner) sees it in a private chat'
            );
            expect(
                visibility.isTemplateVisible(aliceGroup, visibleIn(BOB.id, false, [ALICE.id], false)),
                "a member's group template where its creator is known: visible"
            );
            expect(
                !visibility.isTemplateVisible(aliceGroup, visibleIn(BOB.id, false, [], false)),
                'where its creator was never seen: hidden'
            );
            expect(
                visibility.isTemplateVisible(aliceGroup, visibleIn(ALICE.id, false, [], true)),
                'in a private chat its creator sees it'
            );
            expect(
                !visibility.isTemplateVisible(aliceGroup, visibleIn(BOB.id, false, [BOB.id], true)),
                'in a private chat nobody else does (its known-member set is the chat user alone)'
            );

            // private: only inside a private chat, and there only its creator and the owner
            expect(
                !visibility.isTemplateVisible(alicePrivate, visibleIn(ALICE.id, false, [], false)),
                'a private template is hidden from its creator inside a group'
            );
            expect(
                !visibility.isTemplateVisible(alicePrivate, visibleIn(OWNER_ID, true, [], false)),
                'the owner does not see a private template in a group either'
            );
            expect(
                visibility.isTemplateVisible(alicePrivate, visibleIn(ALICE.id, false, [], true)),
                'in a private chat its creator sees it'
            );
            expect(
                visibility.isTemplateVisible(alicePrivate, visibleIn(OWNER_ID, true, [], true)),
                'and so does the owner'
            );
            expect(
                !visibility.isTemplateVisible(alicePrivate, visibleIn(BOB.id, false, [ALICE.id], true)),
                'nobody else sees it, even in a private chat where its creator is a known member'
            );
        },
    },
    {
        name: "visibility: another creator's group template is visible only where that creator is a known member",
        body: async () => {
            const aliceGroup = syntheticTemplate({
                id: 1,
                name: 'alice-group',
                content: 'x',
                createdBy: ALICE.id,
                visibility: 'group',
            });
            const visibleIn = (viewerId: number, knownMemberIds: number[], isPrivateChat: boolean) => ({
                viewerId,
                isOwner: false,
                knownMemberIds: new Set(knownMemberIds),
                isPrivateChat,
            });
            expect(
                visibility.isTemplateVisible(aliceGroup, visibleIn(BOB.id, [ALICE.id], false)),
                'visible where the creator is a known member of the chat'
            );
            expect(
                !visibility.isTemplateVisible(aliceGroup, visibleIn(BOB.id, [], false)),
                'hidden in a chat where the bot has never seen the creator'
            );
            expect(
                visibility.isTemplateVisible(aliceGroup, visibleIn(CAROL.id, [ALICE.id], false)),
                'any panel user of that chat sees a group template whose creator is a known member'
            );
        },
    },
    {
        name: 'loadKnownChatMemberIds: a private chat is its own user; a group reads chat_members_seen',
        body: async () => {
            const privateMembers = await visibility.loadKnownChatMemberIds(ALICE.id);
            expect(
                privateMembers.size === 1 && privateMembers.has(ALICE.id),
                `a private chat reports only its user (got ${jsonOfText([...privateMembers])})`
            );
            const groupMembers = await visibility.loadKnownChatMemberIds(GROUP_MAIN);
            expect(
                groupMembers.size === 1 && groupMembers.has(ALICE.id),
                `a group reports the members the bot has seen (got ${jsonOfText([...groupMembers])})`
            );
            const emptyMembers = await visibility.loadKnownChatMemberIds(GROUP_OTHER);
            expect(emptyMembers.size === 0, 'a group where nobody was seen has no member');
        },
    },
    {
        name: 'auto candidates: enabled templates by the owner or a known member; a private one only in its creator’s or the owner’s private chat',
        body: async () => {
            const ownerGlobal = syntheticTemplate({
                id: 1,
                name: 'owner-global',
                content: 'x',
                createdBy: OWNER_ID,
                visibility: 'global',
            });
            const memberGroup = syntheticTemplate({
                id: 2,
                name: 'member-group',
                content: 'x',
                createdBy: ALICE.id,
                visibility: 'group',
            });
            const strangerGlobal = syntheticTemplate({
                id: 3,
                name: 'stranger-global',
                content: 'x',
                createdBy: CAROL.id,
                visibility: 'global',
            });
            const memberPrivate = syntheticTemplate({
                id: 4,
                name: 'member-private',
                content: 'x',
                createdBy: ALICE.id,
                visibility: 'private',
            });
            const ownerPrivate = syntheticTemplate({
                id: 5,
                name: 'owner-private',
                content: 'x',
                createdBy: OWNER_ID,
                visibility: 'private',
            });
            const disabledGlobal = syntheticTemplate({
                id: 6,
                name: 'disabled-global',
                content: 'x',
                createdBy: ALICE.id,
                visibility: 'global',
                enabled: false,
            });
            const inGroup: AutoCandidateContext = {
                ownerId: OWNER_ID,
                knownMemberIds: new Set([ALICE.id]),
                privateChatUserId: null,
            };
            const inAliceChat: AutoCandidateContext = {
                ownerId: OWNER_ID,
                knownMemberIds: new Set([ALICE.id]),
                privateChatUserId: ALICE.id,
            };
            const inBobChat: AutoCandidateContext = {
                ownerId: OWNER_ID,
                knownMemberIds: new Set([ALICE.id]),
                privateChatUserId: BOB.id,
            };
            const inOwnerChat: AutoCandidateContext = {
                ownerId: OWNER_ID,
                knownMemberIds: new Set([OWNER_ID]),
                privateChatUserId: OWNER_ID,
            };
            expect(visibility.isAutoCandidate(ownerGlobal, inGroup), "the owner's enabled template is a candidate");
            expect(visibility.isAutoCandidate(memberGroup, inGroup), "a known member's enabled template is a candidate");
            expect(
                !visibility.isAutoCandidate(strangerGlobal, inGroup),
                "a stranger's global template is not: the owner or a known member decides"
            );
            expect(!visibility.isAutoCandidate(strangerGlobal, inAliceChat), 'nor in a private chat');
            expect(!visibility.isAutoCandidate(memberPrivate, inGroup), 'a private template is not a candidate in a group');
            expect(visibility.isAutoCandidate(memberPrivate, inAliceChat), "but it is one in its creator's private chat");
            expect(
                !visibility.isAutoCandidate(memberPrivate, inBobChat),
                "one user's private template is not a candidate in another user's private chat"
            );
            expect(
                !visibility.isAutoCandidate(ownerPrivate, inAliceChat),
                "the owner's private template is not a candidate in another user's private chat"
            );
            expect(visibility.isAutoCandidate(ownerPrivate, inOwnerChat), "in the owner's own private chat it is a candidate");
            expect(
                !visibility.isAutoCandidate(disabledGlobal, inGroup) && !visibility.isAutoCandidate(disabledGlobal, inOwnerChat),
                'a disabled template is never a candidate'
            );
            expect(
                !visibility.isAutoCandidate(memberGroup, {
                    ownerId: OWNER_ID,
                    knownMemberIds: new Set<number>(),
                    privateChatUserId: null,
                }),
                'the known-member rule still applies'
            );
        },
    },
    {
        name: 'private: a private template loads only in its creator’s or the owner’s private chat, never in a group or another user’s chat',
        body: async () => {
            const ownerPrivate = syntheticTemplate({
                id: 1,
                name: 'owner-private',
                content: '机主私有内容',
                modelPatterns: ['*'],
                createdBy: OWNER_ID,
                visibility: 'private',
                sortOrder: 10,
            });
            const alicePrivate = syntheticTemplate({
                id: 2,
                name: 'alice-private',
                content: 'Alice 私有内容',
                modelPatterns: ['*'],
                createdBy: ALICE.id,
                visibility: 'private',
                sortOrder: 20,
            });
            const ownerGroup = syntheticTemplate({
                id: 3,
                name: 'owner-group',
                content: '机主公用内容',
                modelPatterns: ['*'],
                createdBy: OWNER_ID,
                visibility: 'group',
                sortOrder: 30,
            });
            const templates = [ownerPrivate, alicePrivate, ownerGroup];
            const manualSelection = { custom: null, templateIds: [1, 2, 3], auto: false };
            const autoSelection = { custom: null, templateIds: null, auto: true };
            const aliceAutoContext: AutoCandidatesContext = { ownerId: OWNER_ID, knownMemberIds: new Set([ALICE.id]) };
            const ownerAutoContext: AutoCandidatesContext = { ownerId: OWNER_ID, knownMemberIds: new Set([OWNER_ID]) };

            // The loadability rule itself
            expect(rules.privateTemplateLoadable(alicePrivate, ALICE_PRIVATE_CHAT), "its creator's private chat may load it");
            expect(!rules.privateTemplateLoadable(alicePrivate, BOB_PRIVATE_CHAT), "another user's private chat may not");
            expect(!rules.privateTemplateLoadable(alicePrivate, GROUP_CHAT), 'a group may not');
            expect(rules.privateTemplateLoadable(ownerPrivate, OWNER_PRIVATE_CHAT), "the owner's own private chat may load any private template");
            expect(
                !rules.privateTemplateLoadable(ownerPrivate, ALICE_PRIVATE_CHAT),
                "a user's private chat may not load the owner's private template"
            );

            // Manual channel
            const manualInGroup = rules.composeChatAddendum(manualSelection, templates, 'm', null, GROUP_CHAT);
            expect(
                jsonOfText(namesOf(manualInGroup.applied)) === jsonOfText(['owner-group']),
                `group: every private template is skipped, the owner's public library still loads (got ${jsonOfText(namesOf(manualInGroup.applied))})`
            );
            const manualInAliceChat = rules.composeChatAddendum(manualSelection, templates, 'm', null, ALICE_PRIVATE_CHAT);
            expect(
                jsonOfText(namesOf(manualInAliceChat.applied)) === jsonOfText(['alice-private', 'owner-group']),
                `Alice's private chat loads her own private template, not the owner's (got ${jsonOfText(namesOf(manualInAliceChat.applied))})`
            );
            const manualInBobChat = rules.composeChatAddendum(manualSelection, templates, 'm', null, BOB_PRIVATE_CHAT);
            expect(
                jsonOfText(namesOf(manualInBobChat.applied)) === jsonOfText(['owner-group']),
                `Bob's private chat loads none of the private ids (got ${jsonOfText(namesOf(manualInBobChat.applied))})`
            );
            const manualInOwnerChat = rules.composeChatAddendum(manualSelection, templates, 'm', null, OWNER_PRIVATE_CHAT);
            expect(
                jsonOfText(namesOf(manualInOwnerChat.applied)) === jsonOfText(['owner-private', 'alice-private', 'owner-group']),
                `the owner's own private chat loads every private id (got ${jsonOfText(namesOf(manualInOwnerChat.applied))})`
            );

            // Automatic channel
            const autoInGroup = rules.composeChatAddendum(autoSelection, templates, 'm', aliceAutoContext, GROUP_CHAT);
            expect(
                jsonOfText(namesOf(autoInGroup.applied)) === jsonOfText(['owner-group']),
                `group auto: private templates stay out (got ${jsonOfText(namesOf(autoInGroup.applied))})`
            );
            const autoInAliceChat = rules.composeChatAddendum(autoSelection, templates, 'm', aliceAutoContext, ALICE_PRIVATE_CHAT);
            expect(
                jsonOfText(namesOf(autoInAliceChat.applied)) === jsonOfText(['alice-private', 'owner-group']),
                `Alice's private chat auto-loads her own private template (got ${jsonOfText(namesOf(autoInAliceChat.applied))})`
            );
            const autoInBobChat = rules.composeChatAddendum(autoSelection, templates, 'm', aliceAutoContext, BOB_PRIVATE_CHAT);
            expect(
                jsonOfText(namesOf(autoInBobChat.applied)) === jsonOfText(['owner-group']),
                `Bob's private chat auto-loads none of Alice's private templates (got ${jsonOfText(namesOf(autoInBobChat.applied))})`
            );
            const autoInOwnerChat = rules.composeChatAddendum(autoSelection, templates, 'm', ownerAutoContext, OWNER_PRIVATE_CHAT);
            expect(
                jsonOfText(namesOf(autoInOwnerChat.applied)) === jsonOfText(['owner-private', 'owner-group']),
                `the owner's private chat auto-loads the owner's private template, not another user's (got ${jsonOfText(namesOf(autoInOwnerChat.applied))})`
            );
        },
    },
    {
        name: 'compose: nothing selected and auto off loads nothing even when a rule matches',
        body: async () => {
            const matching = syntheticTemplate({
                id: 1,
                name: 'matching',
                content: '匹配内容',
                createdBy: OWNER_ID,
                visibility: 'global',
                modelPatterns: ['*'],
            });
            const composed = rules.composeChatAddendum(
                { custom: null, templateIds: null, auto: false },
                [matching],
                'any-model',
                null,
                GROUP_CHAT
            );
            expect(
                composed.text === null && composed.applied.length === 0 && !composed.customIncluded,
                `nothing is loaded (got ${jsonOfText(composed)})`
            );
        },
    },
    {
        name: 'compose: a manually enabled template loads whatever its model rule and creator; a private one only in its creator’s or the owner’s private chat',
        body: async () => {
            const templates = [
                syntheticTemplate({
                    id: 1,
                    name: 'manual-other-model',
                    content: '手动一',
                    modelPatterns: ['zzz*'],
                    visibility: 'group',
                    createdBy: CAROL.id,
                    sortOrder: 20,
                }),
                syntheticTemplate({ id: 2, name: 'manual-enabled', content: '手动二', visibility: 'group', sortOrder: 10 }),
                syntheticTemplate({
                    id: 3,
                    name: 'manual-private-alice',
                    content: '手动三',
                    visibility: 'private',
                    createdBy: ALICE.id,
                    sortOrder: 30,
                }),
                syntheticTemplate({
                    id: 4,
                    name: 'manual-private-carol',
                    content: '手动四',
                    visibility: 'private',
                    createdBy: CAROL.id,
                    sortOrder: 40,
                }),
                syntheticTemplate({ id: 5, name: 'manual-disabled', content: '手动五', enabled: false }),
            ];
            const selection = { custom: null, templateIds: [1, 3, 4, 5, 2, 999], auto: false };
            const inGroup = rules.composeChatAddendum(selection, templates, 'any-model', null, GROUP_CHAT);
            expect(
                jsonOfText(namesOf(inGroup.applied)) === jsonOfText(['manual-enabled', 'manual-other-model']),
                `manual templates load regardless of rule and creator, ordered by (sortOrder, id); every private one is skipped in a group (got ${jsonOfText(namesOf(inGroup.applied))})`
            );
            expect(
                inGroup.text === '手动二\n\n手动一',
                `their contents are joined by a blank line (got ${jsonOfText(inGroup.text)})`
            );
            const inAliceChat = rules.composeChatAddendum(selection, templates, 'any-model', null, ALICE_PRIVATE_CHAT);
            expect(
                jsonOfText(namesOf(inAliceChat.applied)) ===
                    jsonOfText(['manual-enabled', 'manual-other-model', 'manual-private-alice']),
                `Alice's private chat loads her own private template (got ${jsonOfText(namesOf(inAliceChat.applied))})`
            );
            const inBobChat = rules.composeChatAddendum(selection, templates, 'any-model', null, BOB_PRIVATE_CHAT);
            expect(
                jsonOfText(namesOf(inBobChat.applied)) === jsonOfText(['manual-enabled', 'manual-other-model']),
                `Bob's private chat loads neither user's private template (got ${jsonOfText(namesOf(inBobChat.applied))})`
            );
            const inOwnerChat = rules.composeChatAddendum(selection, templates, 'any-model', null, OWNER_PRIVATE_CHAT);
            expect(
                jsonOfText(namesOf(inOwnerChat.applied)) ===
                    jsonOfText(['manual-enabled', 'manual-other-model', 'manual-private-alice', 'manual-private-carol']),
                `the owner's own private chat loads every private id (got ${jsonOfText(namesOf(inOwnerChat.applied))})`
            );
        },
    },
    {
        name: 'compose: a disabled or deleted template loads nothing',
        body: async () => {
            const templates = [
                syntheticTemplate({ id: 1, name: 'disabled', content: '停用内容', enabled: false }),
                syntheticTemplate({ id: 2, name: 'enabled', content: '启用内容' }),
            ];
            const composed = rules.composeChatAddendum(
                { custom: null, templateIds: [1, 999], auto: false },
                templates,
                'any-model',
                null,
                GROUP_CHAT
            );
            expect(composed.applied.length === 0 && composed.text === null, `both are skipped (got ${jsonOfText(composed)})`);
        },
    },
    {
        name: 'compose: auto loads only enabled templates of the owner or a known member whose rule matches; private only where it may load',
        body: async () => {
            const templates = [
                syntheticTemplate({
                    id: 1,
                    name: 'owner-match',
                    content: 'A',
                    modelPatterns: ['m1*'],
                    createdBy: OWNER_ID,
                    visibility: 'global',
                    sortOrder: 30,
                }),
                syntheticTemplate({
                    id: 2,
                    name: 'member-match',
                    content: 'B',
                    modelPatterns: ['m1*'],
                    createdBy: ALICE.id,
                    visibility: 'group',
                    sortOrder: 10,
                }),
                syntheticTemplate({
                    id: 3,
                    name: 'stranger-match',
                    content: 'C',
                    modelPatterns: ['m1*'],
                    createdBy: CAROL.id,
                    visibility: 'global',
                    sortOrder: 20,
                }),
                syntheticTemplate({
                    id: 4,
                    name: 'private-match',
                    content: 'D',
                    modelPatterns: ['m1*'],
                    createdBy: ALICE.id,
                    visibility: 'private',
                    sortOrder: 5,
                }),
                syntheticTemplate({
                    id: 5,
                    name: 'empty-rule',
                    content: 'E',
                    createdBy: OWNER_ID,
                    visibility: 'global',
                    sortOrder: 1,
                }),
                syntheticTemplate({
                    id: 6,
                    name: 'disabled-match',
                    content: 'F',
                    modelPatterns: ['m1*'],
                    createdBy: ALICE.id,
                    visibility: 'group',
                    enabled: false,
                    sortOrder: 0,
                }),
                syntheticTemplate({
                    id: 7,
                    name: 'other-model',
                    content: 'G',
                    modelPatterns: ['m2*'],
                    createdBy: OWNER_ID,
                    visibility: 'global',
                    sortOrder: 0,
                }),
                syntheticTemplate({
                    id: 8,
                    name: 'owner-private-match',
                    content: 'H',
                    modelPatterns: ['m1*'],
                    createdBy: OWNER_ID,
                    visibility: 'private',
                    sortOrder: 6,
                }),
            ];
            const autoContext: AutoCandidatesContext = { ownerId: OWNER_ID, knownMemberIds: new Set([ALICE.id]) };
            const inGroup = rules.composeChatAddendum(
                { custom: null, templateIds: null, auto: true },
                templates,
                'm1-model',
                autoContext,
                GROUP_CHAT
            );
            expect(
                jsonOfText(namesOf(inGroup.applied)) === jsonOfText(['member-match', 'owner-match']),
                `only the owner's and the known member's matching templates load in a group (got ${jsonOfText(namesOf(inGroup.applied))})`
            );

            const inAliceChat = rules.composeChatAddendum(
                { custom: null, templateIds: null, auto: true },
                templates,
                'm1-model',
                autoContext,
                ALICE_PRIVATE_CHAT
            );
            expect(
                jsonOfText(namesOf(inAliceChat.applied)) ===
                    jsonOfText(['private-match', 'member-match', 'owner-match']),
                `Alice's private chat adds her own private template, not the owner's (got ${jsonOfText(namesOf(inAliceChat.applied))})`
            );

            const inBobChat = rules.composeChatAddendum(
                { custom: null, templateIds: null, auto: true },
                templates,
                'm1-model',
                autoContext,
                BOB_PRIVATE_CHAT
            );
            expect(
                jsonOfText(namesOf(inBobChat.applied)) === jsonOfText(['member-match', 'owner-match']),
                `Bob's private chat does not add Alice's private template (got ${jsonOfText(namesOf(inBobChat.applied))})`
            );

            const withoutMembers = rules.composeChatAddendum(
                { custom: null, templateIds: null, auto: true },
                templates,
                'm1-model',
                { ownerId: OWNER_ID, knownMemberIds: new Set() },
                GROUP_CHAT
            );
            expect(
                jsonOfText(namesOf(withoutMembers.applied)) === jsonOfText(['owner-match']),
                `without known members only the owner's template stays (got ${jsonOfText(namesOf(withoutMembers.applied))})`
            );
            const withoutContext = rules.composeChatAddendum(
                { custom: null, templateIds: null, auto: true },
                templates,
                'm1-model',
                null,
                GROUP_CHAT
            );
            expect(withoutContext.applied.length === 0, 'no member context means no auto candidate');
        },
    },
    {
        name: 'compose: an empty loading rule is never auto-loaded, while an explicit * is',
        body: async () => {
            const emptyRule = syntheticTemplate({
                id: 1,
                name: 'empty-rule',
                content: '空规则内容',
                createdBy: OWNER_ID,
                visibility: 'global',
                sortOrder: 20,
            });
            const starRule = syntheticTemplate({
                id: 2,
                name: 'star-rule',
                content: '星号规则内容',
                modelPatterns: ['*'],
                createdBy: OWNER_ID,
                visibility: 'global',
                sortOrder: 10,
            });
            const autoContext: AutoCandidatesContext = { ownerId: OWNER_ID, knownMemberIds: new Set() };
            const composed = rules.composeChatAddendum(
                { custom: null, templateIds: null, auto: true },
                [emptyRule, starRule],
                'any-model',
                autoContext,
                GROUP_CHAT
            );
            expect(
                jsonOfText(namesOf(composed.applied)) === jsonOfText(['star-rule']),
                `only the explicit * auto-loads (got ${jsonOfText(namesOf(composed.applied))})`
            );
            const manual = rules.composeChatAddendum(
                { custom: null, templateIds: [emptyRule.id], auto: false },
                [emptyRule, starRule],
                'any-model',
                null,
                GROUP_CHAT
            );
            expect(
                jsonOfText(namesOf(manual.applied)) === jsonOfText(['empty-rule']),
                'the empty-rule template still loads when enabled by hand'
            );
        },
    },
    {
        name: 'compose: manual and auto deduplicate by id and sort by (sortOrder, id)',
        body: async () => {
            const templates = [
                syntheticTemplate({
                    id: 1,
                    name: 't-late',
                    content: '内容一',
                    modelPatterns: ['*'],
                    sortOrder: 20,
                    createdBy: OWNER_ID,
                    visibility: 'group',
                }),
                syntheticTemplate({
                    id: 2,
                    name: 't-early',
                    content: '内容二',
                    modelPatterns: ['*'],
                    sortOrder: 10,
                    createdBy: OWNER_ID,
                    visibility: 'group',
                }),
                syntheticTemplate({
                    id: 3,
                    name: 't-same-order',
                    content: '内容三',
                    modelPatterns: ['*'],
                    sortOrder: 10,
                    createdBy: OWNER_ID,
                    visibility: 'group',
                }),
            ];
            const composed = rules.composeChatAddendum(
                { custom: null, templateIds: [1, 2], auto: true },
                templates,
                'any-model',
                { ownerId: OWNER_ID, knownMemberIds: new Set() },
                GROUP_CHAT
            );
            expect(
                jsonOfText(namesOf(composed.applied)) === jsonOfText(['t-early', 't-same-order', 't-late']),
                `an id in both lists loads once, ordered by (sortOrder, id) (got ${jsonOfText(namesOf(composed.applied))})`
            );
            expect(composed.text === '内容二\n\n内容三\n\n内容一', `the contents follow the order (got ${jsonOfText(composed.text)})`);
        },
    },
    {
        name: "compose: the chat's own text comes last; blank text is dropped; nothing at all is null",
        body: async () => {
            const templates = [
                syntheticTemplate({
                    id: 1,
                    name: 'first',
                    content: '甲',
                    sortOrder: 0,
                    createdBy: OWNER_ID,
                    visibility: 'group',
                }),
            ];
            const customLast = rules.composeChatAddendum(
                { custom: '自定义', templateIds: [1], auto: false },
                templates,
                'any-model',
                null,
                GROUP_CHAT
            );
            expect(customLast.text === '甲\n\n自定义', `the own text is appended last (got ${jsonOfText(customLast.text)})`);
            expect(customLast.customIncluded, 'customIncluded says so');

            const blank = rules.composeChatAddendum({ custom: '   ', templateIds: null, auto: false }, [], 'any-model', null, GROUP_CHAT);
            expect(blank.text === null && !blank.customIncluded, 'whitespace-only text is dropped');

            const customOnly = rules.composeChatAddendum({ custom: '只有自己', templateIds: null, auto: false }, [], 'any-model', null, GROUP_CHAT);
            expect(
                customOnly.text === '只有自己' && customOnly.applied.length === 0 && customOnly.customIncluded,
                `with no template the own text stands alone (got ${jsonOfText(customOnly)})`
            );
        },
    },
    {
        name: "compose: the trial user's pinned model and the chat's own model match different templates",
        body: async () => {
            const hydrogenGuide = syntheticTemplate({
                id: 1,
                name: 'hydrogen 引导',
                content: 'hydrogen 专用',
                modelPatterns: ['gemini-4-hydrogen'],
                createdBy: OWNER_ID,
                visibility: 'group',
            });
            const asTrial = rules.composeChatAddendum(
                { custom: null, templateIds: null, auto: true },
                [hydrogenGuide],
                'gemini-4-hydrogen',
                { ownerId: OWNER_ID, knownMemberIds: new Set() },
                GROUP_CHAT
            );
            const asFull = rules.composeChatAddendum(
                { custom: null, templateIds: null, auto: true },
                [hydrogenGuide],
                'gemini-4-neon',
                { ownerId: OWNER_ID, knownMemberIds: new Set() },
                GROUP_CHAT
            );
            expect(
                jsonOfText(namesOf(asTrial.applied)) === jsonOfText(['hydrogen 引导']),
                'the trial model matches the rule and the template auto-loads'
            );
            expect(asFull.applied.length === 0, "the chat's own model does not match, so nothing auto-loads");
        },
    },
    {
        name: 'create: any user may create; defaults are global, enabled, order 0; names are unique per creator',
        body: async () => {
            const creatorId = 7001;
            const created = await templatesService.createPromptTemplate(
                { name: '  默认模板  ', content: '  内容  ' },
                { userId: creatorId, isOwner: false }
            );
            expect(created.name === '默认模板' && created.content === '内容', 'name and content are trimmed');
            expect(
                created.visibility === 'global' &&
                    created.enabled &&
                    created.sortOrder === 0 &&
                    jsonOfText(created.modelPatterns) === '[]',
                `defaults are global, enabled, order 0 and no loading rule (got ${jsonOfText(created)})`
            );
            expect(created.createdBy === creatorId, 'the creator is the actor');
            const stored = await PromptTemplateRecord.findByPk(created.id);
            expect(
                stored?.modelPatterns === '[]' &&
                    stored.visibility === 'global' &&
                    stored.enabled === true &&
                    stored.sortOrder === 0 &&
                    stored.createdBy === creatorId,
                `the row holds the normalized defaults (got ${jsonOfText(stored)})`
            );

            const duplicate = await refusalOf(() =>
                templatesService.createPromptTemplate({ name: '默认模板', content: '另一种内容' }, { userId: creatorId, isOwner: false })
            );
            expect(duplicate === 'invalid: 已存在同名模板', `the same name under one creator is refused (got ${duplicate})`);
            const sameNameOtherCreator = await templatesService.createPromptTemplate(
                { name: '默认模板', content: '别人的同名模板' },
                { userId: 7002, isOwner: false }
            );
            expect(
                sameNameOtherCreator.createdBy === 7002 && sameNameOtherCreator.name === '默认模板',
                'another creator may use the same name'
            );
        },
    },
    {
        name: 'create and update: field and shape errors carry their messages; an unknown id is not_found',
        body: async () => {
            const creator = { userId: 7010, isOwner: false };
            const invalidInputs: [string, unknown][] = [
                ['an empty name', { name: '', content: 'x' }],
                ['a 41-character name', { name: 'a'.repeat(41), content: 'x' }],
                ['a newline in the name', { name: 'a\nb', content: 'x' }],
                ['empty content', { name: 'n', content: ' ' }],
                ['4001-code-point content', { name: 'n', content: 'a'.repeat(4001) }],
                ['a NUL in the content', { name: 'n', content: 'a\u0000b' }],
                ['21 loading rules', { name: 'n', content: 'x', modelPatterns: Array.from({ length: 21 }, (_, index) => `m${index}`) }],
                ['a loading rule with whitespace', { name: 'n', content: 'x', modelPatterns: ['a b'] }],
                ['an unknown visibility', { name: 'n', content: 'x', visibility: 'public' }],
                ['a sort order over 100000', { name: 'n', content: 'x', sortOrder: 100001 }],
                ['a string enabled flag', { name: 'n', content: 'x', enabled: 'yes' }],
                ['a body that is not an object', 'x'],
            ];
            for (const [label, input] of invalidInputs) {
                expect(
                    (await rejectionOf(() => templatesService.createPromptTemplate(input, creator))) === 'invalid',
                    `${label} is refused as invalid`
                );
            }
            expect(
                cache.listPromptTemplates().filter((template) => template.createdBy === creator.userId).length === 0,
                'nothing was written by the refused creates'
            );

            const created = await templatesService.createPromptTemplate(
                { name: '可更新模板', content: '可更新内容' },
                creator
            );
            expect(
                (await rejectionOf(() => templatesService.updatePromptTemplate(created.id, {}, creator))) === 'invalid',
                'an empty patch is refused as invalid'
            );
            expect(
                (await rejectionOf(() =>
                    templatesService.updatePromptTemplate(created.id, { content: 'a'.repeat(4001) }, creator)
                )) === 'invalid',
                'an over-long content patch is refused'
            );
            expect(
                cache.getPromptTemplate(created.id)?.content === '可更新内容',
                'a refused update leaves the cache untouched'
            );
            expect(
                (await rejectionOf(() => templatesService.updatePromptTemplate(999999, { content: 'x' }, creator))) ===
                    'not_found',
                'an unknown template id is not_found'
            );
            expect(
                (await rejectionOf(() => templatesService.deletePromptTemplate(999999, creator))) === 'not_found',
                'deleting an unknown template id is not_found'
            );
        },
    },
    {
        name: 'update and delete: the creator or the owner only; the owner manages everyone',
        body: async () => {
            const aliceTemplate = await templatesService.createPromptTemplate(
                { name: '归属测试模板', content: '归属内容' },
                aliceActor
            );
            expect(
                (await rejectionOf(() => templatesService.updatePromptTemplate(aliceTemplate.id, { content: '改' }, bobActor))) ===
                    'forbidden',
                'another user cannot edit it'
            );
            expect(
                (await rejectionOf(() => templatesService.updatePromptTemplate(aliceTemplate.id, { content: '改' }, carolActor))) ===
                    'forbidden',
                'a third user cannot edit it either'
            );
            expect(
                (await rejectionOf(() => templatesService.deletePromptTemplate(aliceTemplate.id, bobActor))) === 'forbidden',
                'another user cannot delete it'
            );
            const ownerUpdate = await templatesService.updatePromptTemplate(
                aliceTemplate.id,
                { name: '机主改名', content: '机主改内容' },
                ownerActor
            );
            expect(
                ownerUpdate.name === '机主改名' && ownerUpdate.content === '机主改内容' && ownerUpdate.createdBy === ALICE.id,
                `the owner may edit it and the creator stays its owner (got ${jsonOfText(ownerUpdate)})`
            );

            const bobTemplate = await templatesService.createPromptTemplate(
                { name: 'Bob 归属测试模板', content: 'Bob 内容' },
                bobActor
            );
            await templatesService.deletePromptTemplate(bobTemplate.id, ownerActor);
            expect(cache.getPromptTemplate(bobTemplate.id) === undefined, 'the owner deleted it from the cache');
            await cache.loadPromptTemplatesCache();
            expect(cache.getPromptTemplate(bobTemplate.id) === undefined, 'and it is gone from the table after a reload');

            const ownUpdate = await templatesService.updatePromptTemplate(aliceTemplate.id, { content: '自己改' }, aliceActor);
            expect(ownUpdate.content === '自己改', 'the creator edits their own template');
            await templatesService.deletePromptTemplate(aliceTemplate.id, aliceActor);
            expect(cache.getPromptTemplate(aliceTemplate.id) === undefined, 'and deletes it');
        },
    },
    {
        name: "update: a rename onto the creator's own other name is refused; another creator keeps their own name",
        body: async () => {
            const creator = { userId: 7020, isOwner: false };
            const first = await templatesService.createPromptTemplate({ name: '原一', content: '内容一' }, creator);
            const second = await templatesService.createPromptTemplate({ name: '原二', content: '内容二' }, creator);
            const duplicate = await refusalOf(() =>
                templatesService.updatePromptTemplate(second.id, { name: '原一' }, creator)
            );
            expect(duplicate === 'invalid: 已存在同名模板', `a duplicate rename is refused (got ${duplicate})`);
            const renamed = await templatesService.updatePromptTemplate(second.id, { name: '新名' }, creator);
            expect(renamed.name === '新名', 'a free name renames the template');
            const sameNameElsewhere = await templatesService.createPromptTemplate(
                { name: '原一', content: '别人的一' },
                { userId: 7021, isOwner: false }
            );
            expect(sameNameElsewhere.createdBy === 7021, 'a different creator may use the same text as a name');
            const unchanged = await templatesService.updatePromptTemplate(first.id, { name: '原一' }, creator);
            expect(unchanged.name === '原一', 'writing the current name is accepted');
        },
    },
    {
        name: 'the cache follows every write and a reload rebuilds the same list; chatCount counts manual lists',
        body: async () => {
            const creator = { userId: 7030, isOwner: false };
            const first = await templatesService.createPromptTemplate(
                { name: '缓存一', content: '缓存一内容', sortOrder: 30 },
                creator
            );
            const second = await templatesService.createPromptTemplate(
                { name: '缓存二', content: '缓存二内容', sortOrder: 10 },
                creator
            );
            expect(
                cache.getPromptTemplate(first.id)?.content === '缓存一内容',
                'a create is in the cache right after it commits'
            );
            expect(
                jsonOfText(
                    cache
                        .listPromptTemplates()
                        .filter((template) => template.id === first.id || template.id === second.id)
                        .map((template) => template.name)
                ) === jsonOfText(['缓存二', '缓存一']),
                'the cache list is ordered by (sortOrder, id)'
            );
            const stored = await PromptTemplateRecord.findByPk(first.id);
            expect(stored?.content === '缓存一内容' && stored.createdBy === creator.userId, 'the row is committed');

            await cache.loadPromptTemplatesCache();
            expect(
                cache.getPromptTemplate(first.id)?.name === '缓存一' && cache.getPromptTemplate(second.id)?.name === '缓存二',
                'a reload keeps both templates'
            );
            await templatesService.deletePromptTemplate(first.id, creator);
            expect(cache.getPromptTemplate(first.id) === undefined, 'a delete drops it from the cache');
            await cache.loadPromptTemplatesCache();
            expect(
                cache.getPromptTemplate(first.id) === undefined && cache.getPromptTemplate(second.id) !== undefined,
                'and it stays gone after a reload while the other remains'
            );

            // chatCount: two chats list the template in their manual selection
            await settingsService.updateChatSettings({ chatId: -6501, patch: { promptTemplateIds: [second.id] }, actor: ownerActor });
            await settingsService.updateChatSettings({ chatId: -6502, patch: { promptTemplateIds: [second.id] }, actor: ownerActor });
            expect(cache.countChatsUsingTemplate(second.id) === 2, `two chats enable it (got ${cache.countChatsUsingTemplate(second.id)})`);
            expect(cache.countChatsUsingTemplate(second.id + 100000) === 0, 'a template no chat lists counts 0');
        },
    },
    {
        name: 'template ids are never reused after a delete',
        body: async () => {
            const creator = { userId: 7040, isOwner: false };
            const first = await templatesService.createPromptTemplate({ name: '不复用', content: 'x' }, creator);
            await templatesService.deletePromptTemplate(first.id, creator);
            const second = await templatesService.createPromptTemplate({ name: '不复用', content: 'x' }, creator);
            expect(second.id > first.id, `a new template gets a larger id (${second.id} > ${first.id})`);
        },
    },
    {
        name: 'two concurrent creates of one name leave exactly one template',
        body: async () => {
            const creator = { userId: 7050, isOwner: false };
            const settled = await Promise.allSettled([
                templatesService.createPromptTemplate({ name: '并发同名', content: '第一份' }, creator),
                templatesService.createPromptTemplate({ name: '并发同名', content: '第二份' }, creator),
            ]);
            const fulfilled = settled.filter((result) => result.status === 'fulfilled');
            const rejected = settled.filter((result) => result.status === 'rejected');
            expect(
                fulfilled.length === 1 && rejected.length === 1,
                `exactly one create wins (fulfilled ${fulfilled.length}, rejected ${rejected.length})`
            );
            const rejection = rejected[0];
            if (rejection === undefined || rejection.status !== 'rejected') throw new Error('no rejection to inspect');
            const reason: unknown = rejection.reason;
            expect(
                reason instanceof settingsService.ChatSettingsError && reason.code === 'invalid',
                `the loser is refused as invalid (got ${String(reason)})`
            );
            expect(
                (await PromptTemplateRecord.count({ where: { createdBy: creator.userId } })) === 1,
                'the table holds one row'
            );
            expect(
                cache.listPromptTemplates().filter((template) => template.createdBy === creator.userId).length === 1,
                'and the cache one template'
            );
        },
    },
    {
        name: 'one creator may own at most 100 templates',
        body: async () => {
            const creator = { userId: 7060, isOwner: false };
            for (let index = 0; index < templatesService.MAX_TEMPLATES_PER_CREATOR; index += 1) {
                await templatesService.createPromptTemplate({ name: `限额 ${index}`, content: 'x' }, creator);
            }
            expect(
                cache.listPromptTemplates().filter((template) => template.createdBy === creator.userId).length ===
                    templatesService.MAX_TEMPLATES_PER_CREATOR,
                'exactly 100 templates exist'
            );
            const refusal = await refusalOf(() =>
                templatesService.createPromptTemplate({ name: '限额 超出', content: 'x' }, creator)
            );
            expect(refusal === 'invalid: 模板数量已达上限（100 个）', `the 101st is refused (got ${refusal})`);
        },
    },
    {
        name: 'resolveReplyAddendum: with the auto switch off a matching group template is not loaded and no member lookup is needed',
        body: async () => {
            const chatId = -6101;
            expect((await ChatMemberSeen.count({ where: { chatId } })) === 0, 'the chat has no known member at all');
            const composed = await templatesService.resolveReplyAddendum(
                chatId,
                { custom: null, templateIds: null, auto: false },
                'viewer-model-a'
            );
            expect(
                composed.text === null && composed.applied.length === 0,
                `the matching group template would auto-load if the switch were on (got ${jsonOfText(composed)})`
            );
        },
    },
    {
        name: 'resolveReplyAddendum: a private template loads from a manual list only inside a private chat',
        body: async () => {
            const inGroup = await templatesService.resolveReplyAddendum(
                -6102,
                { custom: null, templateIds: [alicePrivateTemplate.id], auto: false },
                'completely-unrelated-model'
            );
            expect(
                inGroup.applied.length === 0 && inGroup.text === null,
                `a private template is skipped in a group chat (got ${jsonOfText(inGroup)})`
            );
            const inPrivateChat = await templatesService.resolveReplyAddendum(
                ALICE.id,
                { custom: null, templateIds: [alicePrivateTemplate.id], auto: false },
                'completely-unrelated-model'
            );
            expect(
                jsonOfText(namesOf(inPrivateChat.applied)) === jsonOfText(['Alice 私有模板']) &&
                    inPrivateChat.text === 'Alice 私有内容',
                `the same manual id loads in a private chat, whatever the model (got ${jsonOfText(inPrivateChat)})`
            );
            const withCustom = await templatesService.resolveReplyAddendum(
                ALICE.id,
                { custom: '自定义尾注', templateIds: [alicePrivateTemplate.id], auto: false },
                'completely-unrelated-model'
            );
            expect(
                withCustom.text === 'Alice 私有内容\n\n自定义尾注',
                `the chat's own text is appended last (got ${jsonOfText(withCustom.text)})`
            );
        },
    },
    {
        name: 'resolveReplyAddendum: a private template loads only in its creator’s or the owner’s private chat',
        body: async () => {
            const bobWithOthers = await templatesService.resolveReplyAddendum(
                BOB.id,
                { custom: null, templateIds: [ownerPrivateTemplate.id, alicePrivateTemplate.id], auto: false },
                'viewer-model-a'
            );
            expect(
                bobWithOthers.text === null && bobWithOthers.applied.length === 0,
                `Bob's private chat loads neither the owner's nor Alice's private template (got ${jsonOfText(bobWithOthers)})`
            );
            const bobAuto = await templatesService.resolveReplyAddendum(
                BOB.id,
                { custom: null, templateIds: null, auto: true },
                'viewer-model-a'
            );
            expect(
                !namesOf(bobAuto.applied).includes('机主私有模板') && !namesOf(bobAuto.applied).includes('Alice 私有模板'),
                `the auto channel does not pull them in either (got ${jsonOfText(namesOf(bobAuto.applied))})`
            );

            const aliceWithOwner = await templatesService.resolveReplyAddendum(
                ALICE.id,
                { custom: null, templateIds: [ownerPrivateTemplate.id, alicePrivateTemplate.id], auto: false },
                'viewer-model-a'
            );
            expect(
                jsonOfText(namesOf(aliceWithOwner.applied)) === jsonOfText(['Alice 私有模板']),
                `Alice's private chat loads only her own private template (got ${jsonOfText(namesOf(aliceWithOwner.applied))})`
            );

            const ownerManual = await templatesService.resolveReplyAddendum(
                OWNER_ID,
                { custom: null, templateIds: [ownerPrivateTemplate.id], auto: false },
                'viewer-model-a'
            );
            expect(
                jsonOfText(namesOf(ownerManual.applied)) === jsonOfText(['机主私有模板']),
                `the owner's own private chat loads it (got ${jsonOfText(namesOf(ownerManual.applied))})`
            );
            const ownerAuto = await templatesService.resolveReplyAddendum(
                OWNER_ID,
                { custom: null, templateIds: null, auto: true },
                'viewer-model-a'
            );
            expect(
                jsonOfText(namesOf(ownerAuto.applied)) === jsonOfText(['机主公用模板', '机主私有模板']),
                `and auto-loads it when its rule matches (got ${jsonOfText(namesOf(ownerAuto.applied))})`
            );
            expect(
                !namesOf(ownerAuto.applied).includes('Alice 私有模板'),
                "another user's private template does not auto-load in the owner's chat"
            );
        },
    },
    {
        name: "resolveReplyAddendum: auto loads the owner's and a known member's matching templates, never a private one in a group",
        body: async () => {
            const chatKnown = -6201;
            const chatUnknown = -6202;
            const seen = new Date();
            await ChatMemberSeen.create({
                chatId: chatKnown,
                userId: ALICE.id,
                firstSeenAt: seen,
                lastSeenAt: seen,
                messageCount: 1,
            });
            const known = await templatesService.resolveReplyAddendum(
                chatKnown,
                { custom: null, templateIds: null, auto: true },
                'viewer-model-a'
            );
            expect(
                jsonOfText(known.applied.map((template) => template.name)) ===
                    jsonOfText(['机主公用模板', 'Alice 群可见模板', 'Alice 全局模板']),
                `the owner's, the known member's and her global templates load (got ${jsonOfText(namesOf(known.applied))})`
            );
            expect(
                !namesOf(known.applied).includes('Alice 私有模板') && !namesOf(known.applied).includes('Alice 空规则模板'),
                'a private template and a template without a rule stay out of the auto channel'
            );

            const unknown = await templatesService.resolveReplyAddendum(
                chatUnknown,
                { custom: null, templateIds: null, auto: true },
                'viewer-model-a'
            );
            expect(
                jsonOfText(unknown.applied.map((template) => template.name)) === jsonOfText(['机主公用模板']),
                `without a seen member only the owner's template loads (got ${jsonOfText(namesOf(unknown.applied))})`
            );

            await ChatMemberSeen.create({
                chatId: chatUnknown,
                userId: ALICE.id,
                firstSeenAt: seen,
                lastSeenAt: seen,
                messageCount: 1,
            });
            const afterSpeaking = await templatesService.resolveReplyAddendum(
                chatUnknown,
                { custom: null, templateIds: null, auto: true },
                'viewer-model-a'
            );
            expect(
                jsonOfText(afterSpeaking.applied.map((template) => template.name)) ===
                    jsonOfText(['机主公用模板', 'Alice 群可见模板', 'Alice 全局模板']),
                'once the creator is a known member, her templates auto-load there too'
            );
        },
    },
    {
        name: "resolveReplyAddendum: in a private chat auto loads the owner's, the user's own and their private templates",
        body: async () => {
            const alicePrivateChat = await templatesService.resolveReplyAddendum(
                ALICE.id,
                { custom: null, templateIds: null, auto: true },
                'viewer-model-a'
            );
            expect(
                jsonOfText(alicePrivateChat.applied.map((template) => template.name)) ===
                    jsonOfText(['机主公用模板', 'Alice 群可见模板', 'Alice 私有模板', 'Alice 全局模板']),
                `Alice's private chat loads her private template too (got ${jsonOfText(namesOf(alicePrivateChat.applied))})`
            );
            const bobPrivateChat = await templatesService.resolveReplyAddendum(
                BOB.id,
                { custom: null, templateIds: null, auto: true },
                'viewer-model-a'
            );
            expect(
                jsonOfText(bobPrivateChat.applied.map((template) => template.name)) ===
                    jsonOfText(['机主公用模板', 'Bob 群可见模板', 'Bob 全局模板']),
                `Bob's private chat does not pull in Alice's templates (got ${jsonOfText(namesOf(bobPrivateChat.applied))})`
            );
        },
    },
    {
        name: 'resolveReplyAddendum: a private template left in a group settings row loads nothing there',
        body: async () => {
            const created = await templatesService.createPromptTemplate(
                {
                    name: '残留私有模板',
                    content: '残留私有内容',
                    modelPatterns: ['*'],
                    visibility: 'private',
                },
                aliceActor
            );
            const inGroup = await templatesService.resolveReplyAddendum(
                -6401,
                { custom: null, templateIds: [created.id], auto: false },
                'any-model'
            );
            expect(
                inGroup.applied.length === 0 && inGroup.text === null,
                `the group settings row keeps the id, composition skips it (got ${jsonOfText(inGroup)})`
            );
            const autoKnownGroup = await templatesService.resolveReplyAddendum(
                -6201,
                { custom: null, templateIds: null, auto: true },
                'viewer-model-a'
            );
            expect(
                !namesOf(autoKnownGroup.applied).includes('残留私有模板'),
                'the auto channel never picks a private template in a group'
            );
            const inPrivateChat = await templatesService.resolveReplyAddendum(
                ALICE.id,
                { custom: null, templateIds: [created.id], auto: false },
                'any-model'
            );
            expect(
                jsonOfText(namesOf(inPrivateChat.applied)) === jsonOfText(['残留私有模板']),
                `the same id loads in a private chat (got ${jsonOfText(namesOf(inPrivateChat.applied))})`
            );
            await templatesService.deletePromptTemplate(created.id, aliceActor);
        },
    },
    {
        name: 'resolveReplyAddendum: deleted and disabled templates are skipped in both channels',
        body: async () => {
            const created = await templatesService.createPromptTemplate(
                { name: '解析测试模板', content: '解析内容' },
                aliceActor
            );
            const loaded = await templatesService.resolveReplyAddendum(
                -6301,
                { custom: null, templateIds: [created.id], auto: false },
                'any-model'
            );
            expect(jsonOfText(namesOf(loaded.applied)) === jsonOfText(['解析测试模板']), 'the template loads while enabled');

            await templatesService.updatePromptTemplate(created.id, { enabled: false }, aliceActor);
            const whileDisabled = await templatesService.resolveReplyAddendum(
                -6301,
                { custom: null, templateIds: [created.id], auto: false },
                'any-model'
            );
            expect(whileDisabled.applied.length === 0 && whileDisabled.text === null, 'a disabled manual template loads nothing');

            await templatesService.updatePromptTemplate(created.id, { enabled: true }, aliceActor);
            await templatesService.deletePromptTemplate(created.id, aliceActor);
            const whileDeleted = await templatesService.resolveReplyAddendum(
                -6301,
                { custom: null, templateIds: [created.id], auto: false },
                'any-model'
            );
            expect(whileDeleted.applied.length === 0 && whileDeleted.text === null, 'a deleted manual template loads nothing');

            const autoOnDisabledGroup = await templatesService.resolveReplyAddendum(
                -6302,
                { custom: null, templateIds: null, auto: true },
                'viewer-model-a'
            );
            expect(
                jsonOfText(namesOf(autoOnDisabledGroup.applied)) === jsonOfText(['机主公用模板']),
                `the disabled group template stays out of the auto channel (got ${jsonOfText(namesOf(autoOnDisabledGroup.applied))})`
            );
        },
    },
    {
        name: 'panel templates: a request without initData is 401; create is 201 and validation is 400',
        body: async () => {
            const aliceCountBefore = cache.listPromptTemplates().filter((template) => template.createdBy === ALICE.id).length;
            await expectError(await call('/api/prompt-templates'), 401, 'unauthorized', 'GET without initData');
            await expectError(
                await call('/api/prompt-templates', { method: 'POST', body: { name: '未鉴权', content: 'x' } }),
                401,
                'unauthorized',
                'POST without initData'
            );

            const createdResponse = await call('/api/prompt-templates', {
                method: 'POST',
                user: ALICE,
                body: {
                    name: ' 新建模板 ',
                    content: ' 第一行\r\n第二行 ',
                    modelPatterns: [' DeepSeek* ', ''],
                    sortOrder: 5,
                    enabled: true,
                },
            });
            expect(createdResponse.status === 201, `create → 201 (got ${createdResponse.status})`);
            const created = templateDetailOf((await jsonOf(createdResponse)).template);
            expect(created.name === '新建模板' && created.content === '第一行\n第二行', 'name and content are normalized');
            expect(
                jsonOfText(created.modelPatterns) === jsonOfText(['deepseek*']) &&
                    created.sortOrder === 5 &&
                    created.enabled,
                `the normalized fields come back (got ${jsonOfText(created)})`
            );
            expect(created.visibility === 'global', `a create without visibility defaults to global (got ${created.visibility})`);
            expect(
                created.createdBy === ALICE.id && created.contentLength === 7 && created.contentPreview === '第一行\n第二行',
                `the creator and the content view (got ${jsonOfText(created)})`
            );
            expect(created.chatCount === 0, 'a new template is enabled in no chat yet');
            expect(!Number.isNaN(Date.parse(created.updatedAt)), 'updatedAt is an ISO time');

            const invalidBodies: [string, unknown][] = [
                ['a missing content', { name: 'n' }],
                ['a missing name', { content: 'c' }],
                ['a blank name', { name: '   ', content: 'c' }],
                ['a 41-character name', { name: 'a'.repeat(41), content: 'c' }],
                ['a blank content', { name: 'n', content: '   ' }],
                ['4001-code-point content', { name: 'n', content: 'a'.repeat(4001) }],
                ['modelPatterns that are not an array', { name: 'n', content: 'c', modelPatterns: 'x' }],
                ['a rule with whitespace', { name: 'n', content: 'c', modelPatterns: ['a b'] }],
                ['an unknown visibility', { name: 'n', content: 'c', visibility: 'public' }],
                ['a negative sort order', { name: 'n', content: 'c', sortOrder: -1 }],
                ['a string enabled flag', { name: 'n', content: 'c', enabled: 'yes' }],
                ['an unknown key', { name: 'n', content: 'c', colour: 'red' }],
            ];
            for (const [label, body] of invalidBodies) {
                await expectError(
                    await call('/api/prompt-templates', { method: 'POST', user: ALICE, body }),
                    400,
                    'invalid',
                    `create with ${label}`
                );
            }
            const badVisibility = await call('/api/prompt-templates', {
                method: 'POST',
                user: ALICE,
                body: { name: 'n', content: 'c', visibility: 'public' },
            });
            const badVisibilityError = errorOf(await jsonOf(badVisibility));
            expect(
                badVisibility.status === 400 &&
                    badVisibilityError.code === 'invalid' &&
                    badVisibilityError.message.includes('全局可见'),
                `an unknown visibility is refused with the three choices (got ${badVisibility.status} ${badVisibilityError.message})`
            );
            await expectError(
                await call('/api/prompt-templates', { method: 'POST', user: ALICE, rawBody: '[]' }),
                400,
                'invalid',
                'a JSON array body'
            );
            expect(
                cache.listPromptTemplates().filter((template) => template.createdBy === ALICE.id).length ===
                    aliceCountBefore + 1,
                'only the valid create was stored'
            );

            // Put the created template back, so no later case sees it as an auto candidate
            const removed = await call(`/api/prompt-templates/${created.id}`, { method: 'DELETE', user: ALICE });
            expect(removed.status === 200, 'the case cleans up after itself');
        },
    },
    {
        name: 'panel templates: the management list and detail follow ownership; only the creator or the owner writes',
        body: async () => {
            const createdResponse = await call('/api/prompt-templates', {
                method: 'POST',
                user: BOB,
                body: { name: 'Bob 的管理模板', content: 'Bob 管理内容' },
            });
            expect(createdResponse.status === 201, 'Bob creates a template');
            const bobTemplate = templateDetailOf((await jsonOf(createdResponse)).template);

            const byCreator = templateDetailOf((await getJson(`/api/prompt-templates/${bobTemplate.id}`, { user: BOB })).template);
            expect(byCreator.content === 'Bob 管理内容', 'the creator reads the whole content');
            await expectError(
                await call(`/api/prompt-templates/${bobTemplate.id}`, { user: ALICE }),
                403,
                'forbidden',
                'GET by another user'
            );
            const byOwner = templateDetailOf((await getJson(`/api/prompt-templates/${bobTemplate.id}`, { user: OWNER })).template);
            expect(byOwner.content === 'Bob 管理内容', 'the owner reads any template');

            await expectError(
                await call(`/api/prompt-templates/${bobTemplate.id}`, { method: 'PATCH', user: ALICE, body: { content: '改' } }),
                403,
                'forbidden',
                'PATCH by another user'
            );
            const ownerPatch = await call(`/api/prompt-templates/${bobTemplate.id}`, {
                method: 'PATCH',
                user: OWNER,
                body: { content: '机主改的内容' },
            });
            expect(ownerPatch.status === 200, `the owner PATCHes it (got ${ownerPatch.status})`);
            expect(
                templateDetailOf((await jsonOf(ownerPatch)).template).content === '机主改的内容',
                'the owner patch is stored'
            );
            await expectError(
                await call(`/api/prompt-templates/${bobTemplate.id}`, { method: 'PATCH', user: BOB, body: {} }),
                400,
                'invalid',
                'an empty patch'
            );
            await expectError(
                await call(`/api/prompt-templates/${bobTemplate.id}`, {
                    method: 'PATCH',
                    user: BOB,
                    body: { sortOrder: -1 },
                }),
                400,
                'invalid',
                'a PATCH with a bad sort order'
            );
            const creatorPatch = await call(`/api/prompt-templates/${bobTemplate.id}`, {
                method: 'PATCH',
                user: BOB,
                body: { visibility: 'group' },
            });
            expect(creatorPatch.status === 200, 'the creator PATCHes their own template');

            await expectError(
                await call(`/api/prompt-templates/${bobTemplate.id}`, { method: 'DELETE', user: ALICE }),
                403,
                'forbidden',
                'DELETE by another user'
            );
            const deleted = await call(`/api/prompt-templates/${bobTemplate.id}`, { method: 'DELETE', user: OWNER });
            expect(deleted.status === 200 && (await jsonOf(deleted)).ok === true, 'the owner deletes it with {ok:true}');
            await expectError(await call(`/api/prompt-templates/${bobTemplate.id}`, { user: BOB }), 404, 'not_found', 'GET after delete');
            await expectError(
                await call(`/api/prompt-templates/${bobTemplate.id}`, { method: 'DELETE', user: OWNER }),
                404,
                'not_found',
                'DELETE again'
            );
            await expectError(await call('/api/prompt-templates/999999', { user: BOB }), 404, 'not_found', 'an unknown id');
            await expectError(await call('/api/prompt-templates/abc', { user: BOB }), 400, 'invalid', 'a non-numeric id');

            const aliceList = templateListOf(await getJson('/api/prompt-templates', { user: ALICE }));
            expect(
                aliceList.length > 0 && aliceList.every((item) => item.createdBy === ALICE.id),
                'a normal user lists only their own templates'
            );
            expect(namesByItem(aliceList).includes('Alice 群可见模板'), 'their own templates are in it');
            expect(aliceList.some((item) => item.id === alicePrivateTemplate.id), 'the management list keeps their own private template');
            const bobList = templateListOf(await getJson('/api/prompt-templates', { user: BOB }));
            expect(bobList.every((item) => item.createdBy === BOB.id), 'Bob lists only his own');
            const ownerList = templateListOf(await getJson('/api/prompt-templates', { user: OWNER }));
            expect(
                ownerList.length === cache.listPromptTemplates().length,
                `the owner lists every template (${ownerList.length} vs ${cache.listPromptTemplates().length})`
            );
            expect(
                ownerList.some((item) => item.id === alicePrivateTemplate.id),
                "the owner management list still contains other users' private templates"
            );
        },
    },
    {
        name: 'panel chat templates: a group list drops private templates and reports enabledInChat and autoMatchesViewerModel',
        body: async () => {
            const setModel = await call(`/api/chats/${GROUP_MAIN}/settings`, {
                method: 'PATCH',
                user: ALICE,
                body: { model: 'viewer-model-a', promptTemplateIds: null },
            });
            expect(setModel.status === 200, `the chat model is set for the viewer-model rules (got ${setModel.status})`);

            const aliceView = chatTemplateListOf(
                await getJson(`/api/chats/${GROUP_MAIN}/prompt-templates`, { user: ALICE })
            );
            expect(
                aliceView.every((item) => !item.enabledInChat),
                'nothing is manually enabled in the chat yet'
            );
            expect(
                aliceView.every((item) => item.visibility !== 'private'),
                'a group chat lists no private template, not even for its creator'
            );
            expect(
                aliceView.some((item) => item.id === aliceOtherModelTemplate.id) &&
                    aliceView.some((item) => item.id === aliceDisabledTemplate.id) &&
                    aliceView.some((item) => item.id === aliceGlobalTemplate.id) &&
                    aliceView.some((item) => item.id === aliceNoRuleTemplate.id),
                'her own non-private templates are in the list, the global ones included'
            );
            expect(
                !aliceView.some((item) => item.id === alicePrivateTemplate.id),
                'her own private template is not listed in a group'
            );
            expect(itemNamed(aliceView, '机主公用模板').autoMatchesViewerModel, "the owner's matching group template would auto-load");
            expect(itemNamed(aliceView, 'Alice 群可见模板').autoMatchesViewerModel, 'so would her own matching group template');
            expect(itemNamed(aliceView, 'Alice 全局模板').autoMatchesViewerModel, 'a global template by a known member auto-loads too');
            expect(!itemNamed(aliceView, 'Alice 空规则模板').autoMatchesViewerModel, 'a template without a loading rule never auto-loads');
            expect(!itemNamed(aliceView, 'Alice 其他模型模板').autoMatchesViewerModel, 'a mismatching rule does not auto-load');
            expect(!itemNamed(aliceView, 'Alice 停用模板').autoMatchesViewerModel, 'a disabled template does not auto-load');
            expect(
                !aliceView.some((item) => item.name === 'Bob 群可见模板'),
                "Bob's group template is hidden: he is not a known member of this chat"
            );
            expect(
                aliceView.some((item) => item.id === bobGlobalTemplate.id),
                "a global template is visible even though its creator is unknown here"
            );
            expect(
                !itemNamed(aliceView, 'Bob 全局模板').autoMatchesViewerModel,
                "but a stranger's global template never auto-loads"
            );

            const enabled = await call(`/api/chats/${GROUP_MAIN}/settings`, {
                method: 'PATCH',
                user: ALICE,
                body: { promptTemplateIds: [aliceGroupTemplate.id] },
            });
            expect(enabled.status === 200, 'the chat enables a template');
            const afterEnabling = chatTemplateListOf(
                await getJson(`/api/chats/${GROUP_MAIN}/prompt-templates`, { user: ALICE })
            );
            expect(itemNamed(afterEnabling, 'Alice 群可见模板').enabledInChat, 'enabledInChat reports the manual list');
            expect(itemNamed(afterEnabling, 'Alice 群可见模板').chatCount === 1, 'chatCount counts the enabling chat');
            expect(!itemNamed(afterEnabling, '机主公用模板').enabledInChat, 'another template stays off');

            const bobView = chatTemplateListOf(
                await getJson(`/api/chats/${GROUP_MAIN}/prompt-templates`, { user: BOB })
            );
            expect(
                !bobView.some((item) => item.id === alicePrivateTemplate.id),
                "Alice's private template stays hidden from Bob"
            );
            expect(itemNamed(bobView, 'Alice 群可见模板').autoMatchesViewerModel, 'Alice is a known member here, so her group template is visible');
            expect(itemNamed(bobView, 'Alice 全局模板').autoMatchesViewerModel, 'so is her global template');
            expect(bobView.some((item) => item.id === bobGroupTemplate.id), 'Bob sees his own group template');
            expect(
                !itemNamed(bobView, 'Bob 群可见模板').autoMatchesViewerModel,
                'Bob is not a known member himself, so his group template does not auto-load'
            );
            expect(
                !itemNamed(bobView, 'Bob 全局模板').autoMatchesViewerModel,
                'nor does his global template auto-load for him'
            );

            const ownerView = chatTemplateListOf(
                await getJson(`/api/chats/${GROUP_MAIN}/prompt-templates`, { user: OWNER })
            );
            expect(
                ownerView.every((item) => item.visibility !== 'private'),
                'the owner does not see a private template in a group list either'
            );
            const nonPrivateCount = cache.listPromptTemplates().filter((template) => template.visibility !== 'private').length;
            expect(
                ownerView.length === nonPrivateCount,
                `the owner sees every non-private template in the chat list (${ownerView.length} vs ${nonPrivateCount})`
            );

            const otherView = chatTemplateListOf(
                await getJson(`/api/chats/${GROUP_OTHER}/prompt-templates`, { user: BOB })
            );
            expect(otherView.some((item) => item.id === ownerGroupTemplate.id), "the owner's template is visible in every chat");
            expect(
                !itemNamed(otherView, '机主公用模板').autoMatchesViewerModel,
                "this chat's model does not match the owner template's rule, so it does not auto-load"
            );
            expect(
                !otherView.some((item) => item.name === 'Alice 群可见模板'),
                "Alice's group template is hidden in a chat where she was never seen"
            );
            expect(
                otherView.some((item) => item.id === aliceGlobalTemplate.id),
                "Alice's global template is visible even where she was never seen"
            );
            expect(
                !itemNamed(otherView, 'Alice 全局模板').autoMatchesViewerModel,
                'but it does not auto-load there: the creator is not a known member'
            );

            await expectError(
                await call(`/api/chats/${GROUP_LEFT}/prompt-templates`, { user: ALICE }),
                403,
                'forbidden',
                'a chat Alice is not a member of'
            );
            await expectError(
                await call('/api/chats/-1009999999999/prompt-templates', { user: ALICE }),
                403,
                'forbidden',
                'an unknown chat'
            );
            await expectError(
                await call('/api/chats/abc/prompt-templates', { user: ALICE }),
                400,
                'invalid',
                'a non-numeric chat id'
            );
        },
    },
    {
        name: 'panel chat templates: a private chat lists private templates and refuses everyone else',
        body: async () => {
            const setModel = await call(`/api/chats/${ALICE.id}/settings`, {
                method: 'PATCH',
                user: ALICE,
                body: { model: 'viewer-model-a', promptTemplateIds: null },
            });
            expect(setModel.status === 200, 'the private chat model is set');
            const view = chatTemplateListOf(await getJson(`/api/chats/${ALICE.id}/prompt-templates`, { user: ALICE }));
            expect(itemNamed(view, 'Alice 私有模板').name === 'Alice 私有模板', 'her own private template is listed in her private chat');
            expect(
                itemNamed(view, 'Alice 私有模板').autoMatchesViewerModel,
                'a private template with a matching rule auto-loads inside a private chat'
            );
            expect(itemNamed(view, 'Alice 群可见模板').autoMatchesViewerModel, 'her own group template auto-loads there too');
            expect(itemNamed(view, 'Alice 全局模板').autoMatchesViewerModel, 'and so does her global template');
            expect(!itemNamed(view, 'Alice 空规则模板').autoMatchesViewerModel, 'the one without a rule does not');
            expect(
                view.some((item) => item.id === ownerGroupTemplate.id),
                "the owner's group template is the public library: listed in her private chat too"
            );
            expect(
                itemNamed(view, '机主公用模板').autoMatchesViewerModel,
                "and it auto-loads there: the owner's template matches the model"
            );
            expect(!view.some((item) => item.name === 'Bob 群可见模板'), "Bob's group template is not visible in her private chat");

            const enabled = await call(`/api/chats/${ALICE.id}/settings`, {
                method: 'PATCH',
                user: ALICE,
                body: { promptTemplateIds: [alicePrivateTemplate.id] },
            });
            expect(enabled.status === 200, 'she enables her private template in her private chat');
            const afterEnabling = chatTemplateListOf(
                await getJson(`/api/chats/${ALICE.id}/prompt-templates`, { user: ALICE })
            );
            expect(itemNamed(afterEnabling, 'Alice 私有模板').enabledInChat, 'enabledInChat reports it');

            // The preview composes with the private chat's user, so another
            // user's private template must never reach it
            const ownAuto = previewOf(
                await getJson(`/api/chats/${ALICE.id}/settings/preview`, {
                    method: 'POST',
                    user: ALICE,
                    body: { promptTemplateIds: [], promptTemplatesAuto: true },
                })
            );
            expect(
                namesOf(ownAuto.appliedTemplates).includes('Alice 私有模板'),
                `her own private template is in the auto draft (got ${jsonOfText(namesOf(ownAuto.appliedTemplates))})`
            );
            expect(
                !namesOf(ownAuto.appliedTemplates).includes('机主私有模板') &&
                    !ownAuto.runtimeBlock.includes('机主私有内容'),
                'the owner private template never reaches her private chat preview'
            );
            const guessedPrivateId = previewOf(
                await getJson(`/api/chats/${ALICE.id}/settings/preview`, {
                    method: 'POST',
                    user: ALICE,
                    body: { promptTemplateIds: [ownerPrivateTemplate.id] },
                })
            );
            expect(
                guessedPrivateId.appliedTemplates.length === 0 &&
                    !guessedPrivateId.runtimeBlock.includes('机主私有内容'),
                `a guessed id of another user's private template loads nothing (got ${jsonOfText(guessedPrivateId)})`
            );

            await expectError(
                await call(`/api/chats/${ALICE.id}/prompt-templates`, { user: BOB }),
                403,
                'forbidden',
                "another user's private chat"
            );
        },
    },
    {
        name: 'panel chat settings: members set both keys; the audit keeps canonical JSON and true/false; bad values are 400',
        body: async () => {
            const sortedIds = [aliceDisabledTemplate.id, aliceGroupTemplate.id].sort((left, right) => left - right);
            const response = await call(`/api/chats/${GROUP_AUDIT}/settings`, {
                method: 'PATCH',
                user: ALICE,
                body: { promptTemplateIds: [aliceDisabledTemplate.id, aliceGroupTemplate.id], promptTemplatesAuto: true },
            });
            expect(response.status === 200, `a member sets both keys (got ${response.status})`);
            const patched = settingsOf((await jsonOf(response)).settings);
            expect(
                jsonOfText(patched.promptTemplateIds) === jsonOfText(sortedIds) && patched.promptTemplatesAuto,
                `the values come back normalized (got ${jsonOfText(patched)})`
            );
            const dashboard = settingsOf((await getJson(`/api/chats/${GROUP_AUDIT}`, { user: ALICE })).settings);
            expect(
                jsonOfText(dashboard.promptTemplateIds) === jsonOfText(sortedIds) && dashboard.promptTemplatesAuto,
                'the chat view carries both fields'
            );

            const audits = await listSettingsAudit({ scope: `chat:${GROUP_AUDIT}`, limit: 50 });
            const idsAudit = audits.find((entry) => entry.key === 'promptTemplateIds');
            expect(
                idsAudit?.oldValue === null && idsAudit.newValue === jsonOfText(sortedIds),
                `the audit stores canonical JSON (got ${jsonOfText(idsAudit)})`
            );
            const autoAudit = audits.find((entry) => entry.key === 'promptTemplatesAuto');
            expect(
                autoAudit?.oldValue === 'false' && autoAudit.newValue === 'true',
                `the audit stores true/false text (got ${jsonOfText(autoAudit)})`
            );

            const invalidBodies: [string, unknown][] = [
                ['the id 0', { promptTemplateIds: [0] }],
                ['a bare number', { promptTemplateIds: 5 }],
                ['eleven ids', { promptTemplateIds: Array.from({ length: 11 }, (_, index) => index + 1) }],
                ['a fractional id', { promptTemplateIds: [1.5] }],
                ['a string auto switch', { promptTemplatesAuto: 'yes' }],
            ];
            for (const [label, body] of invalidBodies) {
                await expectError(
                    await call(`/api/chats/${GROUP_AUDIT}/settings`, { method: 'PATCH', user: ALICE, body }),
                    400,
                    'invalid',
                    `a patch with ${label}`
                );
            }
            expect(
                (await listSettingsAudit({ scope: `chat:${GROUP_AUDIT}`, limit: 50 })).length === 2,
                'the refused patches wrote no audit row'
            );
            await expectError(
                await call(`/api/chats/${GROUP_AUDIT}/settings`, {
                    method: 'PATCH',
                    user: ALICE,
                    body: { settingsLocked: true },
                }),
                403,
                'forbidden',
                'a member touching the lock'
            );
        },
    },
    {
        name: 'panel chat settings: a locked chat refuses a member’s template change, the owner still writes',
        body: async () => {
            const locked = await call(`/api/chats/${GROUP_LOCK}/settings`, {
                method: 'PATCH',
                user: OWNER,
                body: { settingsLocked: true },
            });
            expect(locked.status === 200, 'the owner locks the chat');
            await expectError(
                await call(`/api/chats/${GROUP_LOCK}/settings`, {
                    method: 'PATCH',
                    user: ALICE,
                    body: { promptTemplateIds: [aliceGroupTemplate.id] },
                }),
                403,
                'locked',
                'a member changing templates on a locked chat'
            );
            await expectError(
                await call(`/api/chats/${GROUP_LOCK}/settings`, {
                    method: 'PATCH',
                    user: ALICE,
                    body: { promptTemplatesAuto: 'bad' },
                }),
                403,
                'locked',
                'a malformed value is still locked, not invalid'
            );
            const ownerWrite = await call(`/api/chats/${GROUP_LOCK}/settings`, {
                method: 'PATCH',
                user: OWNER,
                body: { promptTemplateIds: [aliceGroupTemplate.id], promptTemplatesAuto: true },
            });
            expect(ownerWrite.status === 200, 'the owner writes the two keys on a locked chat');
            const ownerSettings = settingsOf((await jsonOf(ownerWrite)).settings);
            expect(
                jsonOfText(ownerSettings.promptTemplateIds) === jsonOfText([aliceGroupTemplate.id]) && ownerSettings.promptTemplatesAuto,
                'and the values are stored'
            );
            const unlocked = await call(`/api/chats/${GROUP_LOCK}/settings`, {
                method: 'PATCH',
                user: OWNER,
                body: { settingsLocked: false },
            });
            expect(unlocked.status === 200, 'the owner unlocks it');
        },
    },
    {
        name: 'panel chat settings: more than 8000 composed code points are refused with the actual count',
        body: async () => {
            const longA = await templatesService.createPromptTemplate(
                { name: '预算模板甲', content: '字'.repeat(4000), visibility: 'group' },
                aliceActor
            );
            const longB = await templatesService.createPromptTemplate(
                { name: '预算模板乙', content: '字'.repeat(4000), visibility: 'group' },
                aliceActor
            );
            const atLimit = await call(`/api/chats/${GROUP_BUDGET}/settings`, {
                method: 'PATCH',
                user: ALICE,
                body: { promptTemplateIds: [longA.id, longB.id] },
            });
            expect(atLimit.status === 200, `two 4000-code-point templates are exactly at the limit (got ${atLimit.status})`);
            const over = await call(`/api/chats/${GROUP_BUDGET}/settings`, {
                method: 'PATCH',
                user: ALICE,
                body: { promptAddendum: '超' },
            });
            const overError = errorOf(await jsonOf(over));
            expect(
                over.status === 400 && overError.code === 'invalid' && overError.message.includes('8001'),
                `the refusal names 8001 (got ${over.status} ${overError.code} ${overError.message})`
            );
            expect(
                settingsService.getChatSettings(GROUP_BUDGET)?.promptAddendum === null,
                'the refused save changed nothing'
            );
            const cleaned = await call(`/api/chats/${GROUP_BUDGET}/settings`, {
                method: 'PATCH',
                user: ALICE,
                body: { promptTemplateIds: null },
            });
            expect(cleaned.status === 200, 'the case cleans the template list up');
            const withText = await call(`/api/chats/${GROUP_BUDGET}/settings`, {
                method: 'PATCH',
                user: ALICE,
                body: { promptAddendum: '超' },
            });
            expect(withText.status === 200, 'with no template the own text alone fits');
        },
    },
    {
        name: 'panel preview: omitted keys fall back to the chat, drafts override them, and the composed length is reported',
        body: async () => {
            const saved = await call(`/api/chats/${GROUP_MAIN}/settings`, {
                method: 'PATCH',
                user: ALICE,
                body: {
                    model: 'viewer-model-a',
                    promptTemplateIds: [aliceGroupTemplate.id],
                    promptTemplatesAuto: false,
                    promptAddendum: '自定义尾注',
                },
            });
            expect(saved.status === 200, 'the saved state is set');

            const expectedBase = `${aliceGroupTemplate.content}\n\n自定义尾注`;
            const preview = previewOf(await getJson(`/api/chats/${GROUP_MAIN}/settings/preview`, { method: 'POST', user: ALICE, body: {} }));
            expect(
                preview.runtimeBlock.includes('# 本聊天的附加提示词') &&
                    preview.runtimeBlock.includes(aliceGroupTemplate.content) &&
                    preview.runtimeBlock.includes('自定义尾注'),
                'the runtime block carries the template and the own text'
            );
            expect(
                jsonOfText(namesOf(preview.appliedTemplates)) === jsonOfText(['Alice 群可见模板']),
                `the saved manual list is reported (got ${jsonOfText(namesOf(preview.appliedTemplates))})`
            );
            expect(
                preview.composedCodePoints === codePoints(expectedBase),
                `composedCodePoints counts the joined text (${preview.composedCodePoints} vs ${codePoints(expectedBase)})`
            );
            expect(
                preview.estimatedTokens === Math.ceil(codePoints(expectedBase) * 1.3),
                `estimatedTokens is 1.3 tokens per character (got ${preview.estimatedTokens})`
            );
            expect(preview.injected, 'injected stays true for one release');

            const addendumOnly = previewOf(
                await getJson(`/api/chats/${GROUP_MAIN}/settings/preview`, {
                    method: 'POST',
                    user: ALICE,
                    body: { promptTemplateIds: [] },
                })
            );
            expect(
                addendumOnly.appliedTemplates.length === 0 && addendumOnly.composedCodePoints === codePoints('自定义尾注'),
                `a draft empty list overrides the saved one (got ${jsonOfText(addendumOnly)})`
            );

            const autoDraft = previewOf(
                await getJson(`/api/chats/${GROUP_MAIN}/settings/preview`, {
                    method: 'POST',
                    user: ALICE,
                    body: { promptTemplateIds: [], promptTemplatesAuto: true },
                })
            );
            expect(
                jsonOfText(namesOf(autoDraft.appliedTemplates)) ===
                    jsonOfText(['机主公用模板', 'Alice 群可见模板', 'Alice 全局模板']),
                `the draft auto switch previews the auto candidates, private and rule-less templates excluded (got ${jsonOfText(namesOf(autoDraft.appliedTemplates))})`
            );
            const expectedAuto = `${ownerGroupTemplate.content}\n\n${aliceGroupTemplate.content}\n\n${aliceGlobalTemplate.content}\n\n自定义尾注`;
            expect(
                autoDraft.composedCodePoints === codePoints(expectedAuto),
                `the composed length includes the saved own text (${autoDraft.composedCodePoints} vs ${codePoints(expectedAuto)})`
            );

            const templatesOnly = previewOf(
                await getJson(`/api/chats/${GROUP_MAIN}/settings/preview`, {
                    method: 'POST',
                    user: ALICE,
                    body: { promptAddendum: null },
                })
            );
            expect(
                jsonOfText(namesOf(templatesOnly.appliedTemplates)) === jsonOfText(['Alice 群可见模板']) &&
                    templatesOnly.composedCodePoints === codePoints(aliceGroupTemplate.content),
                `a draft null addendum drops the own text (got ${jsonOfText(templatesOnly)})`
            );
        },
    },
    {
        name: 'panel preview: an over-long draft and a non-member are refused; an empty body previews a chat with no settings',
        body: async () => {
            await expectError(
                await call(`/api/chats/${GROUP_MAIN}/settings/preview`, {
                    method: 'POST',
                    user: ALICE,
                    body: { promptAddendum: 'x'.repeat(2001) },
                }),
                400,
                'invalid',
                'an over-long addendum'
            );
            await expectError(
                await call(`/api/chats/${GROUP_MAIN}/settings/preview`, {
                    method: 'POST',
                    user: ALICE,
                    body: { promptTemplatesAuto: 'yes' },
                }),
                400,
                'invalid',
                'a string auto switch'
            );
            await expectError(
                await call(`/api/chats/${GROUP_MAIN}/settings/preview`, {
                    method: 'POST',
                    user: ALICE,
                    body: { promptTemplateIds: [-1] },
                }),
                400,
                'invalid',
                'a negative id'
            );
            await expectError(
                await call(`/api/chats/${GROUP_MAIN}/settings/preview`, {
                    method: 'POST',
                    user: ALICE,
                    body: { unknownKey: true },
                }),
                400,
                'invalid',
                'an unknown key'
            );
            await expectError(
                await call(`/api/chats/${GROUP_LEFT}/settings/preview`, { method: 'POST', user: ALICE, body: {} }),
                403,
                'forbidden',
                'a non-member'
            );

            const emptyChat = previewOf(
                await getJson(`/api/chats/${GROUP_PREVIEW}/settings/preview`, { method: 'POST', user: ALICE, body: {} })
            );
            expect(
                emptyChat.appliedTemplates.length === 0 &&
                    emptyChat.composedCodePoints === 0 &&
                    emptyChat.estimatedTokens === 0 &&
                    !emptyChat.runtimeBlock.includes('# 本聊天的附加提示词'),
                `a chat with no settings previews no addendum (got ${jsonOfText(emptyChat)})`
            );
        },
    },
    {
        name: 'a reply sends its manually enabled template to the model, and auto only while the chat switch is on',
        body: async () => {
            const chatId = -7001;
            const replyTemplate = await templatesService.createPromptTemplate(
                {
                    name: '回复测试模板',
                    content: 'REPLY_BLOCK_ALPHA',
                    modelPatterns: ['mimo*'],
                    sortOrder: 0,
                    visibility: 'group',
                    enabled: true,
                },
                ownerActor
            );
            const member = { userId: 1111, isOwner: false };
            const setSettings = async (patch: import('../../src/services/chat-settings-service.js').ChatSettingsPatch): Promise<void> => {
                await settingsService.updateChatSettings({ chatId, patch, actor: member });
            };
            await setSettings({ model: 'mimo-v2.6-flash', promptTemplateIds: [replyTemplate.id], promptTemplatesAuto: false });

            const stub = await startChatCompletionStub(mimoStubServer, '好的');
            let messageId = 80_000;
            const sendReply = async (text: string): Promise<void> => {
                messageId += 1;
                await dbIndex.saveMessage({
                    chatId,
                    messageId,
                    userId: member.userId,
                    date: new Date(),
                    userName: 'member',
                    message: text,
                });
                const update = messageUpdate({ chatId, messageId, userId: member.userId, text });
                await quietly(() => handleReply(contextOf(update, createFakeTelegram()), { mention: true }));
            };

            try {
                await sendReply('@AfterSchoolTeatimeBot 第一条');
                expect(stub.requests.length === 1, `the first reply reached the model once (got ${stub.requests.length})`);
                const firstBody = JSON.stringify(stub.requests.at(0) ?? {});
                expect(firstBody.includes('REPLY_BLOCK_ALPHA'), 'the manually enabled template content is in the model request');
                expect(!firstBody.includes('回复测试模板'), 'the template name is never sent to the model');

                await setSettings({ promptTemplateIds: null, promptTemplatesAuto: false });
                await sendReply('@AfterSchoolTeatimeBot 第二条');
                expect(stub.requests.length === 2, 'the second reply reached the model');
                expect(
                    !JSON.stringify(stub.requests.at(1) ?? {}).includes('REPLY_BLOCK_ALPHA'),
                    'with the manual list empty and auto off the template is not sent'
                );

                await setSettings({ promptTemplateIds: null, promptTemplatesAuto: true });
                let thirdLines: string[] = [];
                messageId += 1;
                await dbIndex.saveMessage({
                    chatId,
                    messageId,
                    userId: member.userId,
                    date: new Date(),
                    userName: 'member',
                    message: '@AfterSchoolTeatimeBot 第三条',
                });
                thirdLines = await logsOf(() =>
                    handleReply(
                        contextOf(
                            messageUpdate({
                                chatId,
                                messageId,
                                userId: member.userId,
                                text: '@AfterSchoolTeatimeBot 第三条',
                            }),
                            createFakeTelegram()
                        ),
                        { mention: true }
                    )
                );
                expect(stub.requests.length === 3, `the third reply reached the model (got ${stub.requests.length})`);
                expect(
                    JSON.stringify(stub.requests.at(2) ?? {}).includes('REPLY_BLOCK_ALPHA'),
                    'the auto channel loads the owner template whose rule matches the model'
                );
                expect(
                    thirdLines.some((line) => line.includes('[chat-handler] addendum templates: 回复测试模板')),
                    `the reply log names the loaded template (got ${jsonOfText(thirdLines.filter((line) => line.includes('addendum')))})`
                );
            } finally {
                await stub.close();
            }
        },
    },
    {
        name: 'migration: an old chat_settings table gains the two columns, keeps its row as none/off, and a second run changes nothing',
        body: async () => {
            const chatId = -8001;
            await sequelize.query('DROP TABLE chat_settings');
            await sequelize.query(`
                CREATE TABLE chat_settings (
                    chatId INTEGER PRIMARY KEY, model TEXT DEFAULT NULL, promptAddendum TEXT DEFAULT NULL,
                    paused INTEGER NOT NULL DEFAULT 0, settingsLocked INTEGER NOT NULL DEFAULT 0,
                    toolOverrides TEXT DEFAULT NULL, geminiPriority INTEGER DEFAULT NULL,
                    thinkingEffort TEXT DEFAULT NULL, richReplies INTEGER DEFAULT NULL,
                    updatedAt TEXT NOT NULL, updatedBy INTEGER DEFAULT NULL
                )
            `);
            await sequelize.query(
                `INSERT INTO chat_settings (chatId, model, updatedAt)
                 VALUES (:chatId, 'old-model', '2026-11-18 10:00:00.000 +00:00')`,
                { replacements: { chatId } }
            );
            const before = await columnsOf('chat_settings');
            expect(
                !before.includes('promptTemplateIds') && !before.includes('promptTemplatesAuto'),
                'the old table has neither of the two columns'
            );

            await runSchemaMigrations();
            const after = await columnsOf('chat_settings');
            expect(
                after.includes('promptTemplateIds') && after.includes('promptTemplatesAuto'),
                `the migration adds both columns (got ${jsonOfText(after)})`
            );
            expect(after.length === before.length + 2, 'and nothing else');

            const rows: unknown[] = await sequelize.query(
                'SELECT promptTemplateIds, promptTemplatesAuto FROM chat_settings WHERE chatId = :chatId',
                { replacements: { chatId }, type: QueryTypes.SELECT }
            );
            const row = objectOf(rows[0]);
            expect(row.promptTemplateIds === null, 'the old row enables no template');
            expect(
                row.promptTemplatesAuto === 0 || row.promptTemplatesAuto === false,
                `the old row reads auto off (got ${jsonOfText(row.promptTemplatesAuto)})`
            );

            const migrationRows: unknown[] = await sequelize.query(
                "SELECT COUNT(*) AS count FROM schema_migrations WHERE name = '20261119_prompt_templates'",
                { type: QueryTypes.SELECT }
            );
            expect(numberOf(objectOf(migrationRows[0]).count) === 1, 'the migration is recorded exactly once');

            await runSchemaMigrations();
            expect((await columnsOf('chat_settings')).length === after.length, 'a second run adds nothing');

            await settingsService.loadChatSettingsCache();
            const old = settingsService.getChatSettings(chatId);
            expect(
                old?.model === 'old-model' && old.promptTemplateIds === null && !old.promptTemplatesAuto,
                `the reloaded old row reads as none/off and keeps its model (got ${jsonOfText(old)})`
            );
            const updated = await settingsService.updateChatSettings({
                chatId,
                patch: { promptTemplatesAuto: true },
                actor: ownerActor,
            });
            expect(updated.settings.promptTemplatesAuto === true, 'the migrated columns take writes');
            const storedRows: unknown[] = await sequelize.query(
                'SELECT promptTemplatesAuto FROM chat_settings WHERE chatId = :chatId',
                { replacements: { chatId }, type: QueryTypes.SELECT }
            );
            expect(numberOf(objectOf(storedRows[0]).promptTemplatesAuto) === 1, 'the write is stored as 1');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
await mimoStubServer.close();
endOpenReplies();
reportResults(results);
