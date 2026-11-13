/**
 * Offline cases for the owner's `/probe import` (thinking-effort design
 * 2026-1113-1742 §7): the probe result document parser/whitelist, the mapping
 * onto capability proposals, the command's owner/MIME/size/reply gates, the
 * pending rows it creates, repeated-import refresh, and the apply → catalog
 * effect through the PR3 capability service.
 *
 * Fake Telegram, scratch database, a document that lives in memory: no network,
 * no real files, no model API.
 *
 * Run: npx tsx scripts/offline/probe-import.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import { createFakeBot, groupChat, quietly, userOf } from './fake-telegram.mts';
import type { Chat, Document, Update } from 'grammy/types';
import type { Bot } from 'grammy';

// Identities must be known before anything under src/ is imported
process.env.OWNER_USER_ID = '4242';
process.env.OWNER_DISPLAY_NAME = '机主';
process.env.BOT_USER_ID = '7777';
process.env.BOT_NAME = 'K-ON';
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';

await setupOfflineDb();

const catalogService = await import('../../src/services/model-catalog-service.js');
const probeService = await import('../../src/services/probe-import-service.js');
const capabilityService = await import('../../src/services/model-capability-service.js');
const notifyService = await import('../../src/services/capability-proposal-notify.js');
const probeCommand = await import('../../src/cmd/commands/probe.js');
const { ModelCapabilityProposal } = await import('../../src/db/modelCapabilityProposalDTO.js');
const { ModelCatalogEntryRow } = await import('../../src/db/modelCatalogDTO.js');

const OWNER_ID = 4242;
const OUTSIDER_ID = 6262;
const GROUP_ID = -1009004242;
const LANE_SIGNATURE = 'vertex-adc@global|ephone|ephone|official-xai|official-deepseek|official-mimic';
const PROBED_AT = '2026-11-13T10:00:00.000Z';

const results: CaseResult[] = [];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FixtureResult {
    readonly model: string;
    readonly acceptedEfforts: readonly string[];
    readonly defaultEffort: string | null;
    readonly toggle: boolean;
    readonly errorSummary: Readonly<Record<string, string>>;
    readonly checkedOn: string;
}

const RESULT_HYDROGEN: FixtureResult = {
    model: 'gemini-4-hydrogen',
    acceptedEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'high',
    toggle: false,
    errorSummary: { minimal: '400 Thinking level is unsupported' },
    checkedOn: '2026-11-13',
};

const RESULT_ARGON: FixtureResult = {
    model: 'gemini-4-argon',
    acceptedEfforts: ['low', 'high'],
    defaultEffort: 'high',
    toggle: false,
    errorSummary: { medium: '400 Thinking level is unsupported' },
    checkedOn: '2026-11-13',
};

const RESULT_DEEPSEEK: FixtureResult = {
    model: 'deepseek-flash',
    acceptedEfforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
    toggle: true,
    errorSummary: {},
    checkedOn: '2026-11-13',
};

const RESULT_UNKNOWN: FixtureResult = {
    model: 'model-not-in-catalog',
    acceptedEfforts: ['low'],
    defaultEffort: 'low',
    toggle: false,
    errorSummary: {},
    checkedOn: '2026-11-13',
};

/** A fixture result with arbitrary fields overridden (invalid shapes in the parser cases) */
const variantOf = (base: FixtureResult, changes: Record<string, unknown>): unknown => ({ ...base, ...changes });

const documentTextOf = (entries: readonly unknown[]): string =>
    JSON.stringify({
        schema: 1,
        probedAt: PROBED_AT,
        laneSignature: LANE_SIGNATURE,
        // Unknown keys are ignored by design
        ownerNote: 'anything',
        results: entries,
    });

const VALID_DOCUMENT = documentTextOf([RESULT_HYDROGEN, RESULT_ARGON, RESULT_DEEPSEEK, RESULT_UNKNOWN]);

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------

const privateChat: Chat.PrivateChat = { id: OWNER_ID, type: 'private', first_name: '机主' };
const group: Chat.SupergroupChat = groupChat(GROUP_ID);

const jsonDocument = (overrides: Partial<Document> = {}): Document => ({
    file_id: 'offline-probe-file',
    file_unique_id: 'offline-probe-file-unique',
    file_name: 'probe-results.json',
    mime_type: 'application/json',
    file_size: 512,
    ...overrides,
});

let nextUpdateId = 1;

/**
 * A `/probe import` update answering a document message. Built as plain data
 * and JSON round-tripped because grammy's Message generic for a reply is more
 * precise than a hand-built fixture needs (the handler reads the same fields).
 */
const probeUpdate = (input: {
    readonly chat?: Chat;
    readonly userId?: number;
    readonly text?: string;
    readonly document?: Document | null;
    readonly messageId?: number;
}): Update => {
    const chat = input.chat ?? privateChat;
    const message: Record<string, unknown> = {
        message_id: input.messageId ?? 700_100,
        date: 0,
        chat,
        from: userOf(input.userId ?? OWNER_ID),
        text: input.text ?? '/probe import',
        entities: [{ type: 'bot_command', offset: 0, length: '/probe'.length }],
        ...(input.document === null || input.document === undefined
            ? {}
            : {
                  reply_to_message: {
                      message_id: 700_099,
                      date: 0,
                      chat,
                      from: userOf(5151),
                      document: input.document,
                  },
              }),
    };
    const raw: Record<string, unknown> = { update_id: (nextUpdateId += 1), message };
    return JSON.parse(JSON.stringify(raw));
};

const arrayOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const recordOf = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : null;

const textOfCall = (payload: Readonly<Record<string, unknown>>): string =>
    typeof payload.text === 'string' ? payload.text : '';

// ---------------------------------------------------------------------------
// State the fake command dependencies share
// ---------------------------------------------------------------------------

const { bot, telegram } = createFakeBot();
let currentBytes: Buffer = Buffer.from(VALID_DOCUMENT);
let readCalls = 0;
let notifyCalls = 0;
let readThrows = false;
let useRealNotify = false;

const readDocumentBytes = async (): Promise<Buffer> => {
    readCalls += 1;
    if (readThrows) throw new Error('offline document download failure');
    return currentBytes;
};

const notifyPendingProposals = async (target: Bot): Promise<number> => {
    notifyCalls += 1;
    return useRealNotify ? notifyService.notifyPendingCapabilityProposals(target) : 1;
};

probeCommand.registerProbeCommand(bot, { readDocumentBytes, notifyPendingProposals });

// ---------------------------------------------------------------------------
// Helpers over the scratch database
// ---------------------------------------------------------------------------

const replyTexts = (): readonly string[] => telegram.callsOf('sendMessage').map((call) => textOfCall(call.payload));

const resetState = async (): Promise<void> => {
    telegram.reset();
    readCalls = 0;
    notifyCalls = 0;
    readThrows = false;
    useRealNotify = false;
    currentBytes = Buffer.from(VALID_DOCUMENT);
    await ModelCapabilityProposal.destroy({ where: {} });
    await ModelCatalogEntryRow.destroy({ where: {} });
    await catalogService.loadModelCatalog();
};

const runUpdate = async (update: Update): Promise<readonly string[]> => {
    await quietly(() => bot.handleUpdate(update));
    return replyTexts();
};

const runImport = async (update: Update): Promise<readonly string[]> => {
    telegram.reset();
    return runUpdate(update);
};

const pendingRows = async (): Promise<readonly { id: number; model: string; payload: string; baseline: string | null; note: string | null; messageId: number | null }[]> =>
    ModelCapabilityProposal.findAll({ where: { status: 'pending' }, order: [['id', 'ASC']] }).then((rows) =>
        rows.map((row) => ({
            id: row.id,
            model: row.model,
            payload: row.payload,
            baseline: row.baseline,
            note: row.note,
            messageId: row.messageId,
        }))
    );

const payloadOfRow = (row: { readonly payload: string }): Record<string, unknown> => {
    const parsed = recordOf(JSON.parse(row.payload));
    if (parsed === null) throw new Error('proposal payload is not an object');
    return parsed;
};

const reasoningOfRow = (row: { readonly payload: string }): Record<string, unknown> => {
    const reasoning = recordOf(payloadOfRow(row)['reasoning']);
    if (reasoning === null) throw new Error('proposal payload has no reasoning block');
    return reasoning;
};

const catalogCapabilitiesOf = async (model: string): Promise<Record<string, unknown>> => {
    const row = await ModelCatalogEntryRow.findByPk(model);
    if (row === null) throw new Error(`catalog row ${model} is missing`);
    const parsed = recordOf(JSON.parse(row.capabilities));
    if (parsed === null) throw new Error(`catalog row ${model} capabilities is not an object`);
    return parsed;
};

const manuallyMaintainReasoning = async (model: string): Promise<void> => {
    const capabilities = await catalogCapabilitiesOf(model);
    const reasoning = recordOf(capabilities['reasoning']);
    if (reasoning === null) throw new Error(`no reasoning block for ${model}`);
    const next = { ...capabilities, reasoning: { ...reasoning, source: 'manual' } };
    await ModelCatalogEntryRow.update({ capabilities: JSON.stringify(next) }, { where: { id: model } });
    await catalogService.loadModelCatalog();
};

/** Mark a model's reasoning as the official-doc facts the seed stores */
const maintainOfficialReasoning = async (model: string): Promise<void> => {
    const capabilities = await catalogCapabilitiesOf(model);
    const reasoning = recordOf(capabilities['reasoning']);
    if (reasoning === null) throw new Error(`no reasoning block for ${model}`);
    const next = { ...capabilities, reasoning: { ...reasoning, source: 'official' } };
    await ModelCatalogEntryRow.update({ capabilities: JSON.stringify(next) }, { where: { id: model } });
    await catalogService.loadModelCatalog();
};

const resetReasoningSource = async (model: string): Promise<void> => {
    const capabilities = await catalogCapabilitiesOf(model);
    const reasoning = recordOf(capabilities['reasoning']);
    if (reasoning === null) throw new Error(`no reasoning block for ${model}`);
    const next = { ...capabilities, reasoning: { ...reasoning, source: 'code' } };
    await ModelCatalogEntryRow.update({ capabilities: JSON.stringify(next) }, { where: { id: model } });
    await catalogService.loadModelCatalog();
};

// ---------------------------------------------------------------------------
// 1. Parser and whitelist
// ---------------------------------------------------------------------------

const runParserCases = async (): Promise<void> => {
    results.push(await runCase('parser: a valid document is accepted, unknown keys are ignored', () => {
        const parsed = probeService.parseProbeImportDocument(Buffer.from(VALID_DOCUMENT));
        expect(parsed.ok, `parsed: ${parsed.ok ? '' : parsed.errors.join('; ')}`);
        if (!parsed.ok) return;
        expect(parsed.document.schema === 1, 'schema 1');
        expect(parsed.document.laneSignature === LANE_SIGNATURE, 'lane signature kept');
        expect(parsed.document.results.length === 4, `four results (got ${parsed.document.results.length})`);
        const argon = parsed.document.results.find((entry) => entry.model === 'gemini-4-argon');
        expect(argon !== undefined && JSON.stringify(argon.acceptedEfforts) === JSON.stringify(['low', 'high']), 'accepted efforts are sorted');
        expect(argon?.errorSummary['medium'] !== undefined, 'error summary evidence kept');
    }));

    results.push(await runCase('parser: the whole file is rejected on a bad shape or a bad effort value', () => {
        const invalid: ReadonlyArray<readonly [string, Uint8Array]> = [
            ['empty', Buffer.alloc(0)],
            ['not JSON', Buffer.from('{oops')],
            ['top-level array', Buffer.from('[]')],
            ['schema 2', Buffer.from(JSON.stringify({ schema: 2, probedAt: PROBED_AT, laneSignature: 'x', results: [] }))],
            ['probedAt missing', Buffer.from(JSON.stringify({ schema: 1, laneSignature: 'x', results: [] }))],
            ['probedAt not ISO', Buffer.from(JSON.stringify({ schema: 1, probedAt: 'yesterday', laneSignature: 'x', results: [] }))],
            ['lane signature empty', Buffer.from(JSON.stringify({ schema: 1, probedAt: PROBED_AT, laneSignature: '', results: [] }))],
            ['results not array', Buffer.from(JSON.stringify({ schema: 1, probedAt: PROBED_AT, laneSignature: 'x', results: {} }))],
            ['unknown effort', Buffer.from(documentTextOf([variantOf(RESULT_HYDROGEN, { acceptedEfforts: ['low', 'extreme'] })]))],
            ['duplicate effort', Buffer.from(documentTextOf([variantOf(RESULT_HYDROGEN, { acceptedEfforts: ['low', 'low'] })]))],
            ['duplicate model', Buffer.from(documentTextOf([RESULT_HYDROGEN, RESULT_HYDROGEN]))],
            ['bad default effort', Buffer.from(documentTextOf([variantOf(RESULT_HYDROGEN, { defaultEffort: 'huge' })]))],
            ['toggle not boolean', Buffer.from(documentTextOf([variantOf(RESULT_HYDROGEN, { toggle: 'yes' })]))],
            ['bad checkedOn', Buffer.from(documentTextOf([variantOf(RESULT_HYDROGEN, { checkedOn: '13-11-2026' })]))],
            ['impossible checkedOn', Buffer.from(documentTextOf([variantOf(RESULT_HYDROGEN, { checkedOn: '2026-02-30' })]))],
            ['errorSummary not object', Buffer.from(documentTextOf([variantOf(RESULT_HYDROGEN, { errorSummary: 'nope' })]))],
            ['model missing', Buffer.from(documentTextOf([variantOf(RESULT_HYDROGEN, { model: '' })]))],
        ];
        for (const [label, bytes] of invalid) {
            const parsed = probeService.parseProbeImportDocument(bytes);
            expect(!parsed.ok, `${label}: rejected`);
            if (!parsed.ok) expect(parsed.errors.length > 0, `${label}: has an explanation`);
        }
        const oversized = probeService.parseProbeImportDocument(Buffer.alloc(probeService.PROBE_IMPORT_MAX_BYTES + 1));
        expect(!oversized.ok, 'a document over 1 MB is rejected before parsing');
        if (!oversized.ok) expect(oversized.errors[0]?.includes('1 MB') === true, 'the size error names the limit');
    }));

    results.push(await runCase('parser: a document with zero results is valid but proposes nothing', () => {
        const parsed = probeService.parseProbeImportDocument(Buffer.from(documentTextOf([])));
        expect(parsed.ok, 'empty results array is a valid document');
        if (!parsed.ok) return;
        expect(parsed.document.results.length === 0, 'no rows');
    }));
};

// ---------------------------------------------------------------------------
// 2. Mapping onto proposals (pure)
// ---------------------------------------------------------------------------

const runPlanCases = async (): Promise<void> => {
    results.push(await runCase('plan: reasoning values map to a probe-sourced payload, other fields kept', async () => {
        const parsed = probeService.parseProbeImportDocument(Buffer.from(VALID_DOCUMENT));
        expect(parsed.ok, 'document parses');
        if (!parsed.ok) return;
        const plan = probeService.planProbeImport(parsed.document, await catalogService.listCatalogRows().then((rows) => rows.map((row) => ({ model: row.id, enabled: row.enabled, capabilities: row.capabilities }))));
        const argon = plan.proposals.find((proposal) => proposal.model === 'gemini-4-argon');
        expect(argon !== undefined, 'argon generates a proposal');
        if (argon === undefined) return;
        expect(argon.payload.schema === 1, 'schema 1');
        expect(JSON.stringify(argon.payload.reasoning?.efforts) === JSON.stringify(['low', 'high']), 'accepted efforts written');
        expect(argon.payload.reasoning?.defaultEffort === 'high', 'default effort kept (it is accepted)');
        expect(argon.payload.reasoning?.source === 'probe', 'reasoning source is probe');
        expect(argon.payload.reasoning?.checkedOn === '2026-11-13', 'checkedOn from the result');
        expect(argon.payload.reasoning?.confidence === 'high', 'probe confidence is high');
        expect(JSON.stringify(argon.payload.reasoningEffort) === JSON.stringify(['low', 'high']), 'legacy mirror follows');
        expect(argon.payload.contextTokens === 1_048_576, 'context limit untouched');
        expect(argon.changes.includes('思考档位'), `changes name 思考档位 (got ${argon.changes.join(',')})`);
        expect(argon.note.includes('probe 导入') && argon.note.includes(LANE_SIGNATURE), 'note records the lane signature');
    }));

    results.push(await runCase('plan: identical values with new provenance still get a sync proposal', async () => {
        const synced = probeService.parseProbeImportDocument(Buffer.from(documentTextOf([RESULT_HYDROGEN])));
        expect(synced.ok, 'document parses');
        if (!synced.ok) return;
        const catalog = await catalogService.listCatalogRows().then((rows) => rows.map((row) => ({ model: row.id, enabled: row.enabled, capabilities: row.capabilities })));
        const plan = probeService.planProbeImport(synced.document, catalog);
        expect(plan.proposals.length === 1, 'a provenance-only change is still proposed');
        expect(plan.proposals[0]?.changes.length === 0, 'no field-level change');
        expect(plan.proposals[0]?.note.includes('能力数据同步') === true, 'note says the data is synced');
        // The same document against an already-probe-provenanced catalog changes nothing
        const payload = plan.proposals[0]?.payload;
        expect(payload !== undefined, 'payload exists');
        if (payload === undefined) return;
        const appliedCatalog = [{ model: 'gemini-4-hydrogen', enabled: true, capabilities: payload }];
        const second = probeService.planProbeImport(synced.document, appliedCatalog);
        expect(second.proposals.length === 0 && second.unchanged.length === 1, 're-import after the same data is applied has no proposal');
    }));

    results.push(await runCase('plan: a default effort outside the accepted set becomes null', async () => {
        const parsed = probeService.parseProbeImportDocument(
            Buffer.from(documentTextOf([variantOf(RESULT_ARGON, { acceptedEfforts: ['low'], defaultEffort: 'high' })]))
        );
        expect(parsed.ok, 'document parses');
        if (!parsed.ok) return;
        const catalog = await catalogService.listCatalogRows().then((rows) => rows.map((row) => ({ model: row.id, enabled: row.enabled, capabilities: row.capabilities })));
        const plan = probeService.planProbeImport(parsed.document, catalog);
        const argon = plan.proposals.find((proposal) => proposal.model === 'gemini-4-argon');
        expect(argon?.payload.reasoning?.defaultEffort === null, 'a default the menu cannot offer is dropped');
        expect(argon?.changes.includes('默认档位') === true, 'the drop is visible as a change');
    }));

    results.push(await runCase('plan: unknown models and manually maintained reasoning are skipped', async () => {
        const document = probeService.parseProbeImportDocument(Buffer.from(VALID_DOCUMENT));
        expect(document.ok, 'document parses');
        if (!document.ok) return;
        const catalog = await catalogService.listCatalogRows().then((rows) =>
            rows.map((row) => ({
                model: row.id,
                enabled: row.enabled,
                capabilities:
                    row.id === 'gemini-4-hydrogen' && row.capabilities.reasoning !== undefined
                        ? { ...row.capabilities, reasoning: { ...row.capabilities.reasoning, source: 'manual' as const } }
                        : row.capabilities,
            }))
        );
        const plan = probeService.planProbeImport(document.document, catalog);
        expect(plan.skipped.some((skip) => skip.model === 'model-not-in-catalog'), 'the unknown model is skipped');
        expect(plan.skipped.some((skip) => skip.model === 'gemini-4-hydrogen' && skip.reason.includes('manual')), 'manual reasoning is not proposed over');
        expect(plan.proposals.length === 2, `the other two models still propose (got ${plan.proposals.length})`);
    }));

    results.push(await runCase('plan: a disabled catalog row is skipped', async () => {
        const parsed = probeService.parseProbeImportDocument(Buffer.from(documentTextOf([RESULT_HYDROGEN])));
        expect(parsed.ok, 'document parses');
        if (!parsed.ok) return;
        const catalog = await catalogService
            .listCatalogRows()
            .then((rows) =>
                rows
                    .filter((row) => row.id === 'gemini-4-hydrogen')
                    .map((row) => ({ model: row.id, enabled: false, capabilities: row.capabilities }))
            );
        const plan = probeService.planProbeImport(parsed.document, catalog);
        expect(plan.proposals.length === 0, 'a disabled model is not proposed');
        expect(plan.skipped.some((skip) => skip.reason.includes('未启用')), `the skip reason names the disabled row (got ${JSON.stringify(plan.skipped)})`);
    }));

    results.push(await runCase('plan: a toggle model keeps the catalog default-enabled flag', async () => {
        const parsed = probeService.parseProbeImportDocument(Buffer.from(documentTextOf([RESULT_DEEPSEEK])));
        expect(parsed.ok, 'document parses');
        if (!parsed.ok) return;
        const catalog = await catalogService.listCatalogRows().then((rows) => rows.map((row) => ({ model: row.id, enabled: row.enabled, capabilities: row.capabilities })));
        const plan = probeService.planProbeImport(parsed.document, catalog);
        const deepseek = plan.proposals.find((proposal) => proposal.model === 'deepseek-flash');
        expect(deepseek?.payload.reasoning?.toggle === true, 'toggle true from the document');
        expect(deepseek?.payload.reasoning?.defaultEnabled === true, 'the seed defaultEnabled is preserved (probe does not infer it)');
    }));
};

// ---------------------------------------------------------------------------
// 3. Command gates
// ---------------------------------------------------------------------------

const runGateCases = async (): Promise<void> => {
    results.push(await runCase('command: a non-owner gets no answer and no proposals', async () => {
        await resetState();
        const texts = await runImport(probeUpdate({ userId: OUTSIDER_ID, document: jsonDocument() }));
        expect(texts.length === 0, `silent for a non-owner (got ${texts.length} replies)`);
        expect((await pendingRows()).length === 0, 'no proposal written');
        expect(readCalls === 0, 'the document was never downloaded');
    }));

    results.push(await runCase('command: the owner in a group gets no answer and no proposals', async () => {
        await resetState();
        const texts = await runImport(probeUpdate({ chat: group, document: jsonDocument() }));
        expect(texts.length === 0, `silent outside a private chat (got ${texts.length} replies)`);
        expect((await pendingRows()).length === 0, 'no proposal written');
    }));

    results.push(await runCase('command: /probe without a replied document explains the usage', async () => {
        await resetState();
        const texts = await runImport(probeUpdate({ document: null }));
        expect(texts.length === 1, `one answer (got ${texts.length})`);
        expect(texts[0]?.includes('回复一条带 JSON 文档的消息') === true, `usage text (got ${texts[0] ?? ''})`);
        expect(readCalls === 0, 'nothing downloaded');
        const bare = await runImport(probeUpdate({ text: '/probe' }));
        expect(bare[0]?.includes('用法') === true, 'plain /probe shows the usage');
        const other = await runImport(probeUpdate({ text: '/probe nope' }));
        expect(other[0]?.includes('用法') === true, 'an unknown argument shows the usage');
    }));

    results.push(await runCase('command: a non-JSON document is refused before downloading', async () => {
        await resetState();
        const texts = await runImport(probeUpdate({ document: jsonDocument({ mime_type: 'text/plain' }) }));
        expect(texts.length === 1, 'one answer');
        expect(texts[0]?.includes('application/json') === true, `the MIME type is named (got ${texts[0] ?? ''})`);
        expect(readCalls === 0, 'not downloaded');
        expect((await pendingRows()).length === 0, 'no proposal written');
    }));

    results.push(await runCase('command: an oversized document is refused, declared or actual', async () => {
        await resetState();
        const declared = await runImport(probeUpdate({ document: jsonDocument({ file_size: probeService.PROBE_IMPORT_MAX_BYTES + 1 }) }));
        expect(declared[0]?.includes('1 MB') === true, `declared size refused (got ${declared[0] ?? ''})`);
        expect(readCalls === 0, 'not downloaded when the declared size is too big');
        currentBytes = Buffer.alloc(probeService.PROBE_IMPORT_MAX_BYTES + 1);
        const actual = await runImport(probeUpdate({ document: jsonDocument({ file_size: 100 }) }));
        expect(actual[0]?.includes('1 MB') === true, `actual size refused (got ${actual[0] ?? ''})`);
        expect((await pendingRows()).length === 0, 'no proposal written');
    }));

    results.push(await runCase('command: a failed download is reported and writes nothing', async () => {
        await resetState();
        readThrows = true;
        const texts = await runImport(probeUpdate({ document: jsonDocument() }));
        expect(texts[0]?.includes('下载文档失败') === true, `download failure reported (got ${texts[0] ?? ''})`);
        expect((await pendingRows()).length === 0, 'no proposal written');
    }));

    results.push(await runCase('command: malformed JSON and invalid effort values are rejected with reasons', async () => {
        await resetState();
        currentBytes = Buffer.from('{not json');
        const badJson = await runImport(probeUpdate({ document: jsonDocument() }));
        expect(badJson[0]?.includes('probe 导入被拒绝') === true, `rejected header (got ${badJson[0] ?? ''})`);
        expect(badJson[0]?.includes('不是合法 JSON') === true, 'the JSON error is named');
        currentBytes = Buffer.from(documentTextOf([variantOf(RESULT_HYDROGEN, { acceptedEfforts: ['low', 'bogus'] })]));
        const badEffort = await runImport(probeUpdate({ document: jsonDocument() }));
        expect(badEffort[0]?.includes('acceptedEfforts') === true, `the field is named (got ${badEffort[0] ?? ''})`);
        expect((await pendingRows()).length === 0, 'nothing written by a rejected file');
        expect(notifyCalls === 0, 'no approval message for a rejected file');
    }));
};

// ---------------------------------------------------------------------------
// 4. Import, re-import and apply
// ---------------------------------------------------------------------------

const runImportCases = async (): Promise<void> => {
    results.push(await runCase('import: a valid document queues pending proposals and answers a summary', async () => {
        await resetState();
        const texts = await runImport(probeUpdate({ document: jsonDocument() }));
        expect(texts.length === 1, `one summary (got ${texts.length})`);
        const summary = texts[0] ?? '';
        expect(summary.includes('probe 导入完成'), 'summary header');
        expect(summary.includes('导入 4 个模型'), `model count (got ${summary})`);
        expect(summary.includes('生成 3 条能力提案'), `proposal count (got ${summary})`);
        expect(summary.includes('无变化 0 个'), 'unchanged count');
        expect(summary.includes('跳过 1 个'), 'skipped count');
        expect(summary.includes('model-not-in-catalog'), 'the skipped model is named');
        expect(summary.includes('审批消息已发送（1 条）'), 'approval message reported');
        expect(notifyCalls === 1, 'notify was called once');
        const rows = await pendingRows();
        expect(rows.length === 3, `three pending proposals (got ${rows.length})`);
        expect(rows.map((row) => row.model).sort().join(',') === 'deepseek-flash,gemini-4-argon,gemini-4-hydrogen', 'the expected models');
        const argon = rows.find((row) => row.model === 'gemini-4-argon');
        expect(argon !== undefined, 'argon proposal exists');
        if (argon === undefined) return;
        expect(reasoningOfRow(argon)['source'] === 'probe', 'payload reasoning source is probe');
        expect(reasoningOfRow(argon)['checkedOn'] === '2026-11-13', 'checkedOn carried over');
        expect(reasoningOfRow(argon)['confidence'] === 'high', 'confidence is high');
        expect(argon.note?.includes('probe 导入') === true && argon.note?.includes(LANE_SIGNATURE) === true, 'note names the import and lane');
        expect(argon.baseline !== null && recordOf(JSON.parse(argon.baseline)) !== null, 'baseline snapshot stored');
    }));

    results.push(await runCase('import: re-importing the same document refreshes the same pending rows', async () => {
        await resetState();
        await runImport(probeUpdate({ document: jsonDocument() }));
        const first = await pendingRows();
        notifyCalls = 0;
        const texts = await runImport(probeUpdate({ document: jsonDocument() }));
        const second = await pendingRows();
        expect(second.length === first.length, `pending row count unchanged (${first.length} → ${second.length})`);
        expect(second.map((row) => row.id).join(',') === first.map((row) => row.id).join(','), 'the same proposal ids are refreshed');
        expect(texts[0]?.includes('生成 3 条能力提案') === true, 'the summary reports the same proposals');
        expect(notifyCalls === 1, 'the approval message is sent again');
    }));

    results.push(await runCase('import: applying the proposals writes reasoning.source=probe to the catalog', async () => {
        await resetState();
        await runImport(probeUpdate({ document: jsonDocument() }));
        const rows = await pendingRows();
        const applied = await capabilityService.applyCapabilityProposals(
            rows.map((row) => row.id),
            OWNER_ID
        );
        expect(applied.applied === 3 && applied.skipped === 0, `three applied (got ${applied.applied}/${applied.skipped})`);
        const argon = await catalogCapabilitiesOf('gemini-4-argon');
        const reasoning = recordOf(argon['reasoning']);
        expect(reasoning?.['source'] === 'probe', 'catalog reasoning source is probe');
        expect(JSON.stringify(reasoning?.['efforts']) === JSON.stringify(['low', 'high']), 'applied efforts');
        expect(reasoning?.['defaultEffort'] === 'high', 'applied default effort');
        expect(JSON.stringify(argon['reasoningEffort']) === JSON.stringify(['low', 'high']), 'legacy mirror applied');
        const hydrogen = await catalogCapabilitiesOf('gemini-4-hydrogen');
        expect(recordOf(hydrogen['reasoning'])?.['source'] === 'probe', 'the value-identical model is now probe-sourced');
        const pendingAfter = await pendingRows();
        expect(pendingAfter.length === 0, 'no pending proposal remains after apply');
        notifyCalls = 0;
        const texts = await runImport(probeUpdate({ document: jsonDocument() }));
        expect(texts[0]?.includes('生成 0 条能力提案') === true, `re-import after apply proposes nothing (got ${texts[0] ?? ''})`);
        expect(texts[0]?.includes('无变化 3 个') === true, 'the synced models are counted as unchanged');
        expect(notifyCalls === 0, 'no approval message when nothing is proposed');
    }));

    results.push(await runCase('import: a manually maintained model is skipped, the rest still proposes', async () => {
        await resetState();
        await manuallyMaintainReasoning('gemini-4-hydrogen');
        const texts = await runImport(probeUpdate({ document: jsonDocument() }));
        const rows = await pendingRows();
        expect(rows.length === 2, `two proposals (got ${rows.length})`);
        expect(!rows.some((row) => row.model === 'gemini-4-hydrogen'), 'hydrogen is not proposed over');
        expect(texts[0]?.includes('跳过 2 个') === true, `two skipped (got ${texts[0] ?? ''})`);
        expect(texts[0]?.includes('manual 优先于 probe') === true, 'the manual reason is shown');
        const hydrogen = await catalogCapabilitiesOf('gemini-4-hydrogen');
        expect(recordOf(hydrogen['reasoning'])?.['source'] === 'manual', 'the manual source is untouched');
        await resetReasoningSource('gemini-4-hydrogen');
    }));

    results.push(await runCase('import: an official-doc model is skipped like a manual one', async () => {
        await resetState();
        await maintainOfficialReasoning('gemini-4-hydrogen');
        const texts = await runImport(probeUpdate({ document: jsonDocument() }));
        const rows = await pendingRows();
        expect(rows.length === 2, `two proposals (got ${rows.length})`);
        expect(!rows.some((row) => row.model === 'gemini-4-hydrogen'), 'hydrogen is not proposed over');
        expect(texts[0]?.includes('跳过 2 个') === true, `two skipped (got ${texts[0] ?? ''})`);
        expect(texts[0]?.includes('official 优先于 probe') === true, 'the official reason is shown');
        const hydrogen = await catalogCapabilitiesOf('gemini-4-hydrogen');
        expect(recordOf(hydrogen['reasoning'])?.['source'] === 'official', 'the official source is untouched');
        await resetReasoningSource('gemini-4-hydrogen');
    }));

    results.push(await runCase('import: a measured effort list lifts a seeded supported=false row', async () => {
        await resetState();
        const capabilities = await catalogCapabilitiesOf('gemini-4-hydrogen');
        const reasoning = recordOf(capabilities['reasoning']);
        if (reasoning === null) throw new Error('no reasoning block for the row');
        // A legacy wrap of an empty effort list: supported=false with no efforts
        const emptyReasoning = {
            ...capabilities,
            reasoningEffort: [],
            reasoning: { ...reasoning, supported: false, efforts: [], defaultEffort: null, defaultEnabled: null, source: 'code' },
        };
        await ModelCatalogEntryRow.update(
            { capabilities: JSON.stringify(emptyReasoning) },
            { where: { id: 'gemini-4-hydrogen' } }
        );
        await catalogService.loadModelCatalog();

        await runImport(probeUpdate({ document: jsonDocument() }));
        const rows = await pendingRows();
        const hydrogen = rows.find((row) => row.model === 'gemini-4-hydrogen');
        expect(hydrogen !== undefined, 'the measured model gets a proposal despite supported=false in the catalog');
        if (hydrogen === undefined) return;
        const payloadReasoning = reasoningOfRow(hydrogen);
        expect(payloadReasoning['supported'] === true, 'the payload says supported (probe measured efforts)');
        expect(
            JSON.stringify(payloadReasoning['efforts']) === '["low","medium","high","xhigh"]',
            `the measured effort list is kept (got ${JSON.stringify(payloadReasoning['efforts'])})`
        );
        expect(
            JSON.stringify(payloadOfRow(hydrogen)['reasoningEffort']) === '["low","medium","high","xhigh"]',
            'the legacy mirror follows the measured list'
        );

        const applied = await capabilityService.applyCapabilityProposals([hydrogen.id], OWNER_ID);
        expect(
            applied.applied === 1,
            `the proposal applies (got applied=${applied.applied} superseded=${applied.superseded} unchanged=${applied.unchanged})`
        );
        const stored = await catalogCapabilitiesOf('gemini-4-hydrogen');
        const storedReasoning = recordOf(stored['reasoning']);
        expect(storedReasoning?.['supported'] === true, 'the catalog now says supported');
        expect(
            JSON.stringify(storedReasoning?.['efforts']) === '["low","medium","high","xhigh"]',
            `the efforts survive normalization and apply (got ${JSON.stringify(storedReasoning?.['efforts'])})`
        );
        expect(
            JSON.stringify(stored['reasoningEffort']) === '["low","medium","high","xhigh"]',
            'the legacy mirror is written'
        );
    }));

    results.push(await runCase('import: the real approval message is sent with catalog: buttons', async () => {
        await resetState();
        useRealNotify = true;
        const texts = await runImport(probeUpdate({ document: jsonDocument() }));
        const approval = telegram.callsOf('sendMessage').filter((call) => textOfCall(call.payload).includes('🧩 能力巡检'));
        expect(approval.length === 1, `one approval message (got ${approval.length})`);
        const payload = approval[0]?.payload;
        expect(payload !== undefined, 'approval payload exists');
        if (payload === undefined) return;
        expect(payload['chat_id'] === OWNER_ID, 'sent to the owner chat');
        const markup = recordOf(payload['reply_markup']);
        const keyboardRows = arrayOf(markup?.['inline_keyboard']);
        expect(keyboardRows.length > 0, 'inline keyboard attached');
        const buttons = keyboardRows.flatMap((row) => arrayOf(row));
        const callbackData = buttons.map((button) => {
            const data = recordOf(button)?.['callback_data'];
            return typeof data === 'string' ? data : '';
        });
        expect(callbackData.some((data) => data.startsWith('catalog:apply:')), `per-proposal buttons (got ${callbackData.join(',')})`);
        expect(
            callbackData.some((data) => data.startsWith('catalog:all:apply:')) &&
                callbackData.some((data) => data.startsWith('catalog:all:reject:')),
            'bulk buttons carry a fingerprint'
        );
        expect(
            callbackData.every((data) => /^catalog:(apply:\d+:\d+|all:(apply|reject):\d+)$/.test(data)),
            `every button carries a detectedAt fingerprint (got ${callbackData.join(',')})`
        );
        expect(texts.some((text) => text.includes('审批消息已发送（1 条）')), 'the summary reports the sent message');
        const approvalText = textOfCall(payload);
        expect(approvalText.includes('能力数据同步（字段值未变）'), 'a value-identical probe import is labelled as a sync');
        expect(approvalText.includes('来源 probe'), `the sync proposal shows probe provenance (got ${approvalText})`);
        const rowsWithMessage = (await pendingRows()).filter((row) => row.messageId !== null);
        expect(rowsWithMessage.length === 3, 'every proposal remembers its approval message id');
    }));
};

// ---------------------------------------------------------------------------

results.push(
    await runCase('command module registers the probe command function', async () => {
        await resetState();
        expect(typeof probeCommand.registerProbeCommand === 'function', 'registerProbeCommand is exported');
        expect(typeof probeService.importProbeResultDocument === 'function', 'the import service entry point is exported');
        expect(typeof probeService.planProbeImport === 'function', 'the pure planner is exported');
        expect(typeof probeService.parseProbeImportDocument === 'function', 'the parser is exported');
    })
);

await runImportCases();
await runGateCases();
await runPlanCases();
await runParserCases();

reportResults(results);
