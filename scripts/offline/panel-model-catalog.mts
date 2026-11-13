/**
 * Offline cases for the owner's read-only model catalog page backend
 * (thinking-effort design 2026-1113-1742 §5, PR5 optional):
 * `GET /api/model-catalog` as the panel's Hono app sees it — auth, the owner
 * gate, the payload shape, normalized capabilities, disabled rows, the pending
 * proposal count, the catalogVersion = /api/health invariant and the guarantee
 * that no secret is in the answer. The page's pure formatting module is covered
 * by scripts/offline/webapp-model-catalog.mts.
 *
 * Driven through `app.request()` with self-signed initData and the scratch
 * database: no browser, no network, no real file system outside a temp static
 * root.
 *
 * Run: npx tsx scripts/offline/panel-model-catalog.mts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import { signInitData, type InitDataUserInput } from '../lib/init-data.mts';

const BOT_TOKEN = '42424242:AAFakeOfflineTokenForModelCatalog_012';
const OWNER_ID = 4242;
const ALICE: InitDataUserInput = { id: 5001, first_name: 'Alice' };
const OWNER: InitDataUserInput = { id: OWNER_ID, first_name: 'Owner' };

process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.BOT_USER_ID = '7777';
process.env.BOT_NAME = 'K-ON';
delete process.env.ALLOWED_CHAT_IDS;

await setupOfflineDb();

const catalogService = await import('../../src/services/model-catalog-service.js');
const capabilityService = await import('../../src/services/model-capability-service.js');
const catalogConfig = await import('../../src/config/model-catalog.js');
const capabilitiesConfig = await import('../../src/config/model-capabilities.js');
const { createPanelApp } = await import('../../src/panel/app.js');
const { ModelCatalogEntryRow } = await import('../../src/db/modelCatalogDTO.js');
const { ModelCapabilityProposal } = await import('../../src/db/modelCapabilityProposalDTO.js');

type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;
type PanelApp = ReturnType<typeof createPanelApp>;

const scratch = mkdtempSync(join(tmpdir(), 'k-on-bot-model-catalog-'));
process.once('exit', () => rmSync(scratch, { recursive: true, force: true }));
const STATIC_ROOT = join(scratch, 'dist');
mkdirSync(STATIC_ROOT, { recursive: true });
writeFileSync(join(STATIC_ROOT, 'index.html'), '<!doctype html><title>panel</title><div id="root"></div>');

const results: CaseResult[] = [];

/** The catalog route never asks for chat membership; any answer is enough */
const fakeLookup: MembershipLookup = async () => ({ status: 'member' });

const nowMs = Date.now();
const app: PanelApp = createPanelApp({
    botToken: BOT_TOKEN,
    membershipLookup: fakeLookup,
    staticRoot: STATIC_ROOT,
    startedAt: new Date('2026-11-13T00:00:00.000Z'),
    version: 'abc1234',
    now: () => nowMs,
});

const authDate = Math.floor(nowMs / 1000);

const initDataFor = (user: InitDataUserInput): string => signInitData({ botToken: BOT_TOKEN, user, authDate });

const call = async (path: string, user: InitDataUserInput | null): Promise<Response> => {
    const headers = new Headers();
    if (user !== null) headers.set('X-Init-Data', initDataFor(user));
    return app.request(path, { method: 'GET', headers });
};

const jsonOf = async (response: Response): Promise<Record<string, unknown>> => {
    const parsed: unknown = await response.json();
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? Object.fromEntries(Object.entries(parsed))
        : {};
};

const errorCodeOf = async (response: Response): Promise<string> => {
    const body = await jsonOf(response);
    const error = body['error'];
    return typeof error === 'object' && error !== null && !Array.isArray(error)
        ? String(Object.fromEntries(Object.entries(error))['code'] ?? '-')
        : '-';
};

const catalogOf = async (path = '/api/model-catalog', user: InitDataUserInput | null = OWNER): Promise<Response> =>
    call(path, user);

const modelsOf = (body: Record<string, unknown>): readonly Record<string, unknown>[] => {
    const models = body['models'];
    return Array.isArray(models)
        ? models.map((entry) => (typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry)) : {}))
        : [];
};

const modelById = (body: Record<string, unknown>, id: string): Record<string, unknown> | null =>
    modelsOf(body).find((entry) => entry['id'] === id) ?? null;

/** Put the scratch catalog and proposals back to the seeded state */
const reseed = async (): Promise<void> => {
    await ModelCapabilityProposal.destroy({ where: {} });
    await ModelCatalogEntryRow.destroy({ where: {} });
    await catalogService.loadModelCatalog();
};

/** Replace one row's capabilities JSON (used to test normalization) */
const writeCapabilities = async (model: string, capabilities: unknown): Promise<void> => {
    await ModelCatalogEntryRow.update({ capabilities: JSON.stringify(capabilities) }, { where: { id: model } });
    await catalogService.loadModelCatalog();
};

const capabilitiesOfModel = async (model: string): Promise<Record<string, unknown>> => {
    const entry = await catalogService.findCatalogRow(model);
    if (entry === null) throw new Error(`catalog row ${model} is missing`);
    return Object.fromEntries(Object.entries(entry.capabilities));
};

// ---------------------------------------------------------------------------
// 1. Auth and the owner gate
// ---------------------------------------------------------------------------

const runAuthCases = async (): Promise<void> => {
    results.push(await runCase('auth: without initData the route answers 401', async () => {
        const response = await catalogOf('/api/model-catalog', null);
        expect(response.status === 401, `401 (got ${response.status})`);
        expect((await errorCodeOf(response)) === 'unauthorized', 'error code unauthorized');
    }));

    results.push(await runCase('auth: a verified non-owner answers 403, even with includeDisabled', async () => {
        const response = await catalogOf('/api/model-catalog?includeDisabled=1', ALICE);
        expect(response.status === 403, `403 (got ${response.status})`);
        const body = await jsonOf(response);
        const error = body['error'];
        expect(typeof error === 'object' && error !== null && !Array.isArray(error), 'error envelope present');
        if (typeof error !== 'object' || error === null || Array.isArray(error)) return;
        const errorRecord = Object.fromEntries(Object.entries(error));
        expect(errorRecord['code'] === 'forbidden', 'error code forbidden');
        expect(String(errorRecord['message']).includes('机主'), 'the message says owner only');
    }));
};

// ---------------------------------------------------------------------------
// 2. Shape, normalization and no secrets
// ---------------------------------------------------------------------------

const runShapeCases = async (): Promise<void> => {
    results.push(await runCase('shape: the owner gets the catalog version, pending count and every enabled row', async () => {
        await reseed();
        const response = await catalogOf();
        expect(response.status === 200, `200 (got ${response.status})`);
        const body = await jsonOf(response);
        expect(typeof body['catalogVersion'] === 'string' && String(body['catalogVersion']) !== '', 'catalogVersion is a non-empty string');
        expect(typeof body['pendingProposals'] === 'number', 'pendingProposals is a number');
        const rows = await catalogService.listCatalogRows();
        const enabled = rows.filter((row) => row.enabled);
        expect(modelsOf(body).length === enabled.length, `every enabled row (got ${modelsOf(body).length}, expected ${enabled.length})`);
        expect(modelsOf(body).every((entry) => entry['enabled'] === true), 'the default view has no disabled row');
        expect(new Set(modelsOf(body).map((entry) => String(entry['id']))).size === modelsOf(body).length, 'ids are unique');
        expect(body['catalogVersion'] === catalogConfig.modelCatalogVersion(), 'catalogVersion is the in-memory content hash');
        expect(body['pendingProposals'] === (await capabilityService.countPendingCapabilityProposals()), 'pending count is the service count');
    }));

    results.push(await runCase('shape: a row carries the documented fields and normalized capabilities', async () => {
        await reseed();
        const body = await jsonOf(await catalogOf());
        const hydrogen = modelById(body, 'gemini-4-hydrogen');
        expect(hydrogen !== null, 'hydrogen is listed');
        if (hydrogen === null) return;
        for (const field of ['id', 'label', 'platform', 'enabled', 'source', 'checkedOn', 'confidence', 'traitsOrigin', 'capabilities']) {
            expect(field in hydrogen, `row has ${field}`);
        }
        expect(hydrogen['label'] === 'Gemini 4 Hydrogen', 'label from the catalog row');
        expect(hydrogen['platform'] === 'gemini', 'platform from the catalog row');
        expect(hydrogen['source'] === 'manual', 'row source is the catalog row source');
        expect(hydrogen['traitsOrigin'] === 'catalog', 'traits come from the catalog row after load');
        const capabilities = hydrogen['capabilities'];
        expect(typeof capabilities === 'object' && capabilities !== null, 'capabilities is an object');
        if (typeof capabilities !== 'object' || capabilities === null) return;
        const stats = Object.fromEntries(Object.entries(capabilities));
        expect(stats['schema'] === 1, 'schema 1');
        expect(stats['kind'] === 'chat', 'kind chat');
        expect(stats['contextTokens'] === 1_048_576, 'contextTokens kept');
        const reasoning = stats['reasoning'];
        expect(typeof reasoning === 'object' && reasoning !== null, 'reasoning block present');
        if (typeof reasoning !== 'object' || reasoning === null) return;
        const reasoningRecord = Object.fromEntries(Object.entries(reasoning));
        expect(JSON.stringify(reasoningRecord['efforts']) === JSON.stringify(['low', 'medium', 'high', 'xhigh']), 'efforts normalized and ordered');
        expect(reasoningRecord['defaultEffort'] === 'high', 'default effort kept');
        expect(reasoningRecord['toggle'] === false, 'toggle kept');
        expect(JSON.stringify(stats['reasoningEffort']) === JSON.stringify(['low', 'medium', 'high', 'xhigh']), 'legacy mirror kept');
    }));

    results.push(await runCase('normalization: a schema-less row is answered in the normalized legacy shape', async () => {
        await reseed();
        await writeCapabilities('gemini-4-carbon', {
            kind: 'chat',
            vision: true,
            imageOutput: false,
            tools: true,
            reasoningEffort: ['low', 'bogus', 'high'],
            contextTokens: 4096,
            outputTokens: null,
            apiKey: 'must-not-leak',
        });
        const body = await jsonOf(await catalogOf());
        const carbon = modelById(body, 'gemini-4-carbon');
        expect(carbon !== null, 'carbon is listed');
        if (carbon === null) return;
        const capabilities = carbon['capabilities'];
        expect(typeof capabilities === 'object' && capabilities !== null, 'capabilities present');
        if (typeof capabilities !== 'object' || capabilities === null) return;
        const stats = Object.fromEntries(Object.entries(capabilities));
        expect(stats['kind'] === 'chat' && stats['contextTokens'] === 4096, 'legacy fields normalized');
        expect(!('reasoning' in stats), 'legacy rows have no reasoning block');
        expect(Array.isArray(stats['reasoningEffort']), 'legacy mirror is an array');
        expect(!('apiKey' in stats), 'unknown keys are not echoed');
        const raw = JSON.stringify(body);
        expect(!raw.includes('must-not-leak'), 'unknown raw values never leave the server');
    }));

    results.push(await runCase('normalization: an unknown effort value inside schema 1 is dropped', async () => {
        await reseed();
        const current = await capabilitiesOfModel('gemini-4-hydrogen');
        const reasoning = current['reasoning'];
        const nextReasoning =
            typeof reasoning === 'object' && reasoning !== null
                ? { ...Object.fromEntries(Object.entries(reasoning)), efforts: ['low', 'bogus', 'high'] }
                : { supported: true, efforts: ['low', 'bogus', 'high'] };
        await writeCapabilities('gemini-4-hydrogen', { ...current, reasoning: nextReasoning });
        const body = await jsonOf(await catalogOf());
        const hydrogen = modelById(body, 'gemini-4-hydrogen');
        const capabilities = hydrogen?.['capabilities'];
        expect(typeof capabilities === 'object' && capabilities !== null, 'capabilities present');
        if (typeof capabilities !== 'object' || capabilities === null) return;
        const stats = Object.fromEntries(Object.entries(capabilities));
        const reasoningStats = stats['reasoning'];
        expect(typeof reasoningStats === 'object' && reasoningStats !== null, 'reasoning present');
        if (typeof reasoningStats !== 'object' || reasoningStats === null) return;
        expect(JSON.stringify(Object.fromEntries(Object.entries(reasoningStats))['efforts']) === JSON.stringify(['low', 'high']), 'the unknown value was dropped');
    }));

    results.push(await runCase('no secrets: the answer never contains the bot token', async () => {
        await reseed();
        const response = await catalogOf();
        const text = await response.text();
        expect(!text.includes(BOT_TOKEN), 'the bot token is not in the payload');
    }));
};

// ---------------------------------------------------------------------------
// 3. includeDisabled and catalogVersion
// ---------------------------------------------------------------------------

const runVisibilityCases = async (): Promise<void> => {
    results.push(await runCase('includeDisabled: a retired row is hidden by default and shown on request', async () => {
        await reseed();
        await ModelCatalogEntryRow.update({ enabled: 0 }, { where: { id: 'gemini-4-carbon' } });
        await catalogService.loadModelCatalog();
        const hidden = await jsonOf(await catalogOf());
        expect(modelById(hidden, 'gemini-4-carbon') === null, 'the disabled row is hidden by default');
        expect(modelById(hidden, 'gemini-4-hydrogen') !== null, 'the enabled rows stay');
        const shown = await jsonOf(await catalogOf('/api/model-catalog?includeDisabled=1'));
        const carbon = modelById(shown, 'gemini-4-carbon');
        expect(carbon !== null, 'includeDisabled=1 shows the retired row');
        expect(carbon?.['enabled'] === false, 'it is marked disabled');
        const truthy = await jsonOf(await catalogOf('/api/model-catalog?includeDisabled=true'));
        expect(modelById(truthy, 'gemini-4-carbon') !== null, 'includeDisabled=true works too');
        const zero = await jsonOf(await catalogOf('/api/model-catalog?includeDisabled=0'));
        expect(modelById(zero, 'gemini-4-carbon') === null, 'includeDisabled=0 keeps the default');
    }));

    results.push(await runCase('catalogVersion: equals /api/health and moves when capabilities change', async () => {
        await reseed();
        const first = await jsonOf(await catalogOf());
        const health = await jsonOf(await call('/api/health', null));
        expect(health['catalogVersion'] === first['catalogVersion'], `health and catalog agree (${String(health['catalogVersion'])} vs ${String(first['catalogVersion'])})`);
        const current = await capabilitiesOfModel('gemini-4-argon');
        const reasoning = current['reasoning'];
        const nextReasoning =
            typeof reasoning === 'object' && reasoning !== null
                ? { ...Object.fromEntries(Object.entries(reasoning)), defaultEffort: 'high' }
                : { supported: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'high' };
        await writeCapabilities('gemini-4-argon', { ...current, reasoning: nextReasoning });
        const second = await jsonOf(await catalogOf());
        expect(second['catalogVersion'] !== first['catalogVersion'], 'the version moved with the content');
        const healthAfter = await jsonOf(await call('/api/health', null));
        expect(healthAfter['catalogVersion'] === second['catalogVersion'], 'health agrees again after the change');
    }));
};

// ---------------------------------------------------------------------------
// 4. Pending capability proposals
// ---------------------------------------------------------------------------

const runPendingCases = async (): Promise<void> => {
    results.push(await runCase('pendingProposals: reflects the approval queue', async () => {
        await reseed();
        const current = await capabilitiesConfig.normalizeModelCapabilities(await capabilitiesOfModel('gemini-4-argon')).capabilities;
        const firstId = await capabilityService.upsertCapabilityProposal({
            model: 'gemini-4-argon',
            payload: { ...current, schema: 1 },
            baseline: current,
            note: 'offline test proposal',
            checkedOn: '2026-11-13',
        });
        const secondId = await capabilityService.upsertCapabilityProposal({
            model: 'gemini-4-hydrogen',
            payload: { ...current, schema: 1 },
            baseline: current,
            note: 'offline test proposal',
            checkedOn: '2026-11-13',
        });
        const withTwo = await jsonOf(await catalogOf());
        expect(withTwo['pendingProposals'] === 2, `two pending (got ${String(withTwo['pendingProposals'])})`);
        await capabilityService.rejectCapabilityProposals([firstId], OWNER_ID);
        const withOne = await jsonOf(await catalogOf());
        expect(withOne['pendingProposals'] === 1, `one pending after a rejection (got ${String(withOne['pendingProposals'])})`);
        await capabilityService.rejectCapabilityProposals([secondId], OWNER_ID);
        const withNone = await jsonOf(await catalogOf());
        expect(withNone['pendingProposals'] === 0, 'zero after the second rejection');
    }));
};

// ---------------------------------------------------------------------------

await runAuthCases();
await runShapeCases();
await runVisibilityCases();
await runPendingCases();

await reseed();
reportResults(results);
