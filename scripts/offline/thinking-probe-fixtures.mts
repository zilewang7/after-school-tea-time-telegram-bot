/**
 * Offline cases for the thinking-effort probe (no network, no DB, no secrets).
 *
 * What is covered:
 * - the menu-matrix snapshot (W1 acceptance + fidelity variants, W2 effect
 *   sampling) and the budget cut, including the hard ceilings;
 * - the W2 output-cap switch: default 4096, bounds / help / parse errors, the
 *   cost and `--max-usd` cut following a raised cap, and the cap on the wire;
 * - the request bodies each lane would send: no paid built-in tool may appear,
 *   and each platform gets its own effort parameter;
 * - error classification, which must never turn a 401/404/429 into "the effort
 *   is unsupported";
 * - the design §7 result document and its validation, and the inference of the
 *   vendor default from W2 samples (a sample the probe's own token cap cut is
 *   recorded, counted and excluded from the effect inference);
 * - dry-run sending nothing, and the live loop's retry / circuit breaker /
 *   auth behaviour through injected lanes;
 * - `.env.test`-only credential loading and the test-instance gates, the
 *   lane-id fingerprints that make a changed key/project invalidate old data,
 *   and the DeepSeek/Grok lane fallbacks mirroring the production constructors.
 *
 * Run: `pnpm test:offline thinking-probe-fixtures`
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { GenerateContentResponse } from '@google/genai';
import type { ResponseStreamEvent } from 'openai/resources/responses/responses';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import { MENU_MATRIX } from '../probe/menu-matrix.mts';
import type { ProbeLaneConfiguration, ProbeEnvironment } from '../probe/effort-env.mts';
import { evaluateRunGates, laneConfigurationsOf, laneSignatureOf, loadProbeEnvironment, redactorOf } from '../probe/effort-env.mts';
import { classifyProbeError, createRedactor, fingerprintOf, redactSecrets } from '../probe/effort-errors.mts';
import { createProbeLanes, type ProbeFetch } from '../probe/effort-lanes.mts';
import {
    buildProbePlan,
    clampBudget,
    defaultBudget,
    estimateRequestCostUsd,
    parseModelsJson,
    PROBE_MODEL_SNAPSHOT,
    W2_REPRESENTATIVE_MODELS,
} from '../probe/effort-plan.mts';
import { createStubFetch, stubLaneConfigurations } from '../probe/effort-stub.mts';
import { runProbe } from '../probe/effort-run.mts';
import { HELP as PROBE_HELP, parseArguments as parseProbeCliArguments } from '../probe/thinking-effort.mts';
import { buildRunSummary, formatSummaryMarkdown, inferDefaultEffort, inertEffortsOf, validateProbeDocument } from '../probe/effort-results.mts';
import {
    accumulateGemini,
    accumulateResponses,
    buildAnthropicParams,
    buildChatParams,
    buildGeminiParams,
    buildGrokResponsesParams,
    buildOpenAiResponsesParams,
    createStreamState,
    isTokenCapFinishReason,
    type StreamState,
} from '../probe/effort-wire.mts';
import {
    EFFORT_ORDER,
    HARD_MAX_REQUESTS,
    HARD_MAX_USD,
    MAX_W2_OUTPUT_TOKEN_CAP,
    MIN_W2_OUTPUT_TOKEN_CAP,
    W1_OUTPUT_TOKEN_CAP,
    W2_OUTPUT_TOKEN_CAP,
    isEffortValue,
    isValidW2OutputTokenCap,
    sortEfforts,
    type EffortValue,
    type ProbeCandidate,
    type ProbeObservation,
    type ProbePlatform,
    type ProbeVariant,
} from '../probe/effort-types.mts';

const scratchDirectories: string[] = [];

const scratchDirectory = (): string => {
    const directory = mkdtempSync(join(tmpdir(), 'thinking-probe-'));
    scratchDirectories.push(directory);
    return directory;
};

process.once('exit', () => {
    for (const directory of scratchDirectories) {
        try {
            rmSync(directory, { recursive: true, force: true });
        } catch {
            // A cleanup failure must not hide the test result
        }
    }
});

const results: CaseResult[] = [];

const testEnvironment = (values: Readonly<Record<string, string>> = {}): ProbeEnvironment => {
    const merged: Record<string, string> = {
        TEST_INSTANCE: '1',
        DB_PATH: 'database.test.sqlite',
        OPENAI_API_URL: 'https://api.ephone.ai/v1',
        OPENAI_API_KEY: 'offline-openai-key',
        ANTHROPIC_API_URL: 'https://api.ephone.ai',
        ANTHROPIC_API_KEY: 'offline-anthropic-key',
        GROK_API_URL: 'https://api.x.ai/v1',
        GROK_API_KEY: 'offline-grok-key',
        DEEPSEEK_API_URL: 'https://api.deepseek.com/v1',
        DEEPSEEK_API_KEY: 'offline-deepseek-key',
        MIMO_API_URL: 'https://api.xiaomimimo.com/v1',
        MIMO_API_KEY: 'offline-mimo-key',
        GEMINI_API_KEY: 'offline-gemini-key',
        ...values,
    };
    return {
        values: merged,
        envFilePath: null,
        usedEnvFile: false,
        filledKeys: 0,
        warnings: [],
        secrets: Object.entries(merged)
            .filter(([key, value]) => key.endsWith('KEY') && value.length >= 8)
            .map(([, value]) => value),
    };
};

/** Fake lane configuration; the scripts never dial these hosts in a test */
const fixtureLaneConfigurations = (): Readonly<Record<ProbePlatform, ProbeLaneConfiguration>> => {
    const laneOf = (platform: ProbePlatform, baseUrl: string): ProbeLaneConfiguration => ({
        platform,
        laneId: `fixture:${platform}`,
        baseUrl,
        host: 'stub.invalid',
        apiKey: 'offline-key',
        vertexai: false,
        project: null,
        location: null,
        problems: [],
    });
    return {
        gemini: { ...laneOf('gemini', 'http://stub.invalid/gemini'), laneId: 'fixture-vertex', vertexai: true, apiKey: 'offline-key', baseUrl: null, host: null },
        openai: laneOf('openai', 'http://stub.invalid/openai'),
        anthropic: laneOf('anthropic', 'http://stub.invalid/anthropic'),
        grok: laneOf('grok', 'http://stub.invalid/grok'),
        deepseek: laneOf('deepseek', 'http://stub.invalid/deepseek'),
        mimo: laneOf('mimo', 'http://stub.invalid/mimo'),
    };
};

const candidateOf = (
    platform: ProbePlatform,
    model: string,
    variant: ProbeVariant,
    effort: EffortValue | null,
    options: { readonly withClientTools?: boolean; readonly wave?: 'w1' | 'w2'; readonly repeat?: number } = {}
): ProbeCandidate => ({
    id: `${model}:${options.wave ?? 'w1'}:${variant}:${effort ?? 'auto'}${options.withClientTools === true ? ':tools' : ''}#${options.repeat ?? 1}`,
    model,
    platform,
    wave: options.wave ?? 'w1',
    variant,
    effort,
    withClientTools: options.withClientTools ?? false,
    repeats: 1,
    estimatedCostUsd: 0.001,
});

const observationFixture = (candidate: ProbeCandidate, overrides: Partial<ProbeObservation> = {}): ProbeObservation => ({
    candidateId: candidate.id,
    model: candidate.model,
    platform: candidate.platform,
    wave: candidate.wave,
    variant: candidate.variant,
    effort: candidate.effort,
    withClientTools: candidate.withClientTools,
    expectedRejection: candidate.expectedRejection ?? null,
    attempt: 1,
    startedAt: '2026-11-13T10:00:00.000Z',
    totalMs: 10,
    ttfbMs: 5,
    firstThinkingMs: 6,
    status: 200,
    outcome: 'accepted',
    errorClass: null,
    errorFingerprint: null,
    errorSummary: null,
    inputTokens: 100,
    outputTokens: 12,
    reasoningTokens: 0,
    totalTokens: 112,
    textChars: 2,
    thinkingChars: 8,
    finishReason: 'completed',
    streamError: null,
    requestExcerpt: '{}',
    responseExcerpt: '{}',
    laneHeaders: {},
    laneId: 'fixture',
    estimatedCostUsd: candidate.estimatedCostUsd,
    costUsd: candidate.estimatedCostUsd,
    usageReported: true,
    ...overrides,
});

const createObservationFixture = (
    candidate: ProbeCandidate,
    options: {
        readonly outcome?: ProbeObservation['outcome'];
        readonly errorClass?: string | null;
        readonly reasoningTokens?: number;
        readonly attempt?: number;
    } = {}
): ProbeObservation =>
    observationFixture(candidate, {
        ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
        errorClass: options.errorClass ?? null,
        errorSummary: options.errorClass === null || options.errorClass === undefined ? null : `400 ${options.errorClass} summary`,
        errorFingerprint: options.errorClass === null || options.errorClass === undefined ? null : options.errorClass,
        ...(options.reasoningTokens === undefined ? {} : { reasoningTokens: options.reasoningTokens }),
        ...(options.attempt === undefined ? {} : { attempt: options.attempt }),
    });

const validatedDocumentCheck = (value: unknown): ReturnType<typeof validateProbeDocument> => validateProbeDocument(value);

const checkOnDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

interface ScriptedReply {
    readonly status: number;
    readonly contentType: string;
    readonly body: string;
}

interface CapturedRequest {
    readonly url: string;
    readonly body: Record<string, unknown>;
}

const scriptedFetch = (replies: readonly ScriptedReply[]): { readonly fetch: ProbeFetch; readonly requests: CapturedRequest[] } => {
    const remaining = [...replies];
    const requests: CapturedRequest[] = [];
    const fetch: ProbeFetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const rawBody = typeof init?.body === 'string' ? init.body : '{}';
        const parsed: unknown = JSON.parse(rawBody);
        const body = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed)) : {};
        requests.push({ url, body });
        const reply = remaining.shift();
        if (reply === undefined) throw new Error(`unexpected request to ${url}`);
        return new Response(reply.body, { status: reply.status, headers: { 'content-type': reply.contentType } });
    };
    return { fetch, requests };
};

const sse = (body: string): ScriptedReply => ({ status: 200, contentType: 'text/event-stream', body });
const jsonReply = (status: number, body: unknown): ScriptedReply => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
});

const laneWithScriptedReplies = (platform: ProbePlatform, replies: readonly ScriptedReply[]): { lane: ReturnType<typeof createProbeLanes>[ProbePlatform]; requests: CapturedRequest[] } => {
    const scripted = scriptedFetch(replies);
    const lanes = createProbeLanes(testEnvironment(), { fetch: scripted.fetch, lanes: fixtureLaneConfigurations() });
    return { lane: lanes[platform], requests: scripted.requests };
};

const drainLane = async (platform: ProbePlatform, candidate: ProbeCandidate, reply: ScriptedReply): Promise<ProbeObservation> => {
    const { lane } = laneWithScriptedReplies(platform, [reply]);
    return lane.send(candidate, { maxOutputTokens: 256, timeoutMs: 5_000 });
};

// ---------------------------------------------------------------------------
// 1. Matrix and budget
// ---------------------------------------------------------------------------

const runMatrixCases = async (): Promise<void> => {
    results.push(await runCase('W1 matrix: 13 menu models, 92 acceptance records plus 8 fidelity variants', () => {
        const plan = buildProbePlan({ wave: 'w1', budget: defaultBudget('w1') });
        const acceptance = plan.candidates.filter((candidate) => !candidate.withClientTools);
        const fidelity = plan.candidates.filter((candidate) => candidate.withClientTools);
        expect(acceptance.length === 92, `92 acceptance records (got ${acceptance.length})`);
        expect(fidelity.length === 8, `8 client-tool fidelity variants (got ${fidelity.length})`);
        expect(plan.models.length === 13, `13 menu models (got ${plan.models.length})`);
        expect(plan.candidates.every((candidate) => candidate.wave === 'w1'), 'every candidate is W1');
        expect(new Set(plan.candidates.map((candidate) => candidate.id)).size === plan.candidates.length, 'candidate ids are unique');
    }));

    results.push(await runCase('W1 matrix: per-platform candidate counts match the probe plan', () => {
        const plan = buildProbePlan({ wave: 'w1', budget: defaultBudget('w1') });
        const counts = new Map<ProbePlatform, number>();
        for (const candidate of plan.candidates) counts.set(candidate.platform, (counts.get(candidate.platform) ?? 0) + 1);
        expect(counts.get('gemini') === 26, `gemini 24+2 fidelity (got ${counts.get('gemini')})`);
        expect(counts.get('openai') === 26, `openai 24+2 fidelity (got ${counts.get('openai')})`);
        expect(counts.get('anthropic') === 17, `anthropic 16+1 fidelity (got ${counts.get('anthropic')})`);
        expect(counts.get('grok') === 13, `grok 12+1 fidelity (got ${counts.get('grok')})`);
        expect(counts.get('deepseek') === 9, `deepseek 8+1 fidelity (got ${counts.get('deepseek')})`);
        expect(counts.get('mimo') === 9, `mimo 8+1 fidelity (got ${counts.get('mimo')})`);
    }));

    results.push(await runCase('W2 matrix: 7 representative models, 49 effect samples', () => {
        const plan = buildProbePlan({ wave: 'w2', budget: defaultBudget('w2') });
        expect(plan.candidates.length === 49, `49 W2 requests (got ${plan.candidates.length})`);
        expect(plan.models.every((model) => W2_REPRESENTATIVE_MODELS.includes(model.model)), 'only representative models');
        const perModel = new Map<string, number>();
        for (const candidate of plan.candidates) perModel.set(candidate.model, (perModel.get(candidate.model) ?? 0) + 1);
        expect([...perModel.values()].every((count) => count === 7), 'each model gets baseline x3 + two levels x2');
    }));

    results.push(await runCase('matrix generation is deterministic', () => {
        const first = buildProbePlan({ wave: 'all', budget: defaultBudget('all') });
        const second = buildProbePlan({ wave: 'all', budget: defaultBudget('all') });
        expect(JSON.stringify(first) === JSON.stringify(second), 'the same options produce the same plan bytes');
    }));

    results.push(await runCase('matrix: the menu-matrix snapshot, every model covered by both waves', () => {
        const snapshot = MENU_MATRIX.map((entry) => entry.model);
        expect(snapshot.length === 13, `13 snapshot models (got ${snapshot.length})`);
        const all = buildProbePlan({ wave: 'all', budget: defaultBudget('all') });
        const planned = all.models.map((model) => model.model);
        expect(JSON.stringify(planned) === JSON.stringify(snapshot), `the matrix is the snapshot in order (got ${planned.join(',')})`);
        expect(planned.includes('gpt-6-sol'), 'gpt-6-sol is a menu model and is probed');
        for (const nonMenu of ['gpt-6.1-sol', 'gpt-6.1-terra', 'claude-fable-5-2', 'gemini-3.8-flash']) {
            expect(!planned.includes(nonMenu), `${nonMenu} is not in the menu and is not probed`);
        }
        const w1 = buildProbePlan({ wave: 'w1', budget: defaultBudget('w1') });
        expect(snapshot.every((id) => w1.models.some((model) => model.model === id)), 'every snapshot model has W1 coverage');
        expect(W2_REPRESENTATIVE_MODELS.every((id) => snapshot.includes(id)), 'every W2 representative is a snapshot model');
    }));

    results.push(await runCase('budget cut: max-requests drops the tail, cheap first', () => {
        const plan = buildProbePlan({ wave: 'all', budget: { maxRequests: 40, maxUsd: 3, timeoutMs: 90_000, maxRetries: 1 } });
        expect(plan.candidates.length === 40, `stops at max-requests (got ${plan.candidates.length})`);
        expect(plan.cut.droppedRequests === 109, `drops the rest (got ${plan.cut.droppedRequests})`);
        expect(plan.cut.reasons.includes('--max-requests 40'), 'reason names the limit');
        const costs = plan.candidates.map((candidate) => candidate.estimatedCostUsd);
        expect(costs.every((cost, index) => index === 0 || (costs[index - 1] ?? 0) <= cost), 'kept candidates are cost-ordered');
    }));

    results.push(await runCase('budget cut: max-usd keeps the cheapest subset', () => {
        const plan = buildProbePlan({ wave: 'all', budget: { maxRequests: 250, maxUsd: 0.2, timeoutMs: 90_000, maxRetries: 1 } });
        expect(plan.estimatedUsd <= 0.2, `estimated ${plan.estimatedUsd} within $0.2`);
        expect(plan.cut.droppedRequests > 0, 'something was dropped');
        expect(plan.cut.reasons.includes('--max-usd 0.20'), 'reason names the limit');
    }));

    results.push(await runCase('hard ceilings clamp: 250 requests and $5', () => {
        const budget = clampBudget({ maxRequests: 10_000, maxUsd: 1_000, timeoutMs: 1_000, maxRetries: 99 });
        expect(budget.maxRequests === HARD_MAX_REQUESTS, `requests clamped to ${HARD_MAX_REQUESTS}`);
        expect(budget.maxUsd === HARD_MAX_USD, `usd clamped to ${HARD_MAX_USD}`);
        expect(budget.timeoutMs === 5_000, 'timeout floor is 5s');
        expect(budget.maxRetries === 3, 'retry cap is 3');
        const defaults = defaultBudget('all');
        expect(defaults.maxUsd === 3, 'all-wave default budget is $3 (design §7)');
        expect(defaults.maxRequests === HARD_MAX_REQUESTS, 'all-wave default request cap');
    }));

    results.push(await runCase('w2 sampling picks the vendor default plus the far end', () => {
        const plan = buildProbePlan({ wave: 'w2', budget: defaultBudget('w2') });
        const hydrogen = plan.candidates.filter((candidate) => candidate.model === 'gemini-4-hydrogen' && candidate.variant === 'level');
        const sampled = [...new Set(hydrogen.map((candidate) => candidate.effort))];
        expect(sampled.includes('high'), `hydrogen default high is sampled (got ${sampled.join(',')})`);
        expect(sampled.includes('xhigh'), 'the highest accepted effort is sampled too');
        const deepseek = plan.candidates.filter((candidate) => candidate.model === 'deepseek-flash' && candidate.variant === 'level');
        expect(deepseek.some((candidate) => candidate.effort === 'high'), 'deepseek default high sampled');
    }));

    results.push(await runCase('vendor defaults and efforts come from the capability seed', () => {
        const specOf = (model: string) => PROBE_MODEL_SNAPSHOT.find((spec) => spec.model === model);
        const defaultOf = (model: string): EffortValue | null => specOf(model)?.vendorDefaultEffort ?? null;
        const effortsOf = (model: string): readonly string[] => specOf(model)?.vendorEfforts ?? [];
        // The default is the W2 primary sample and the fallback written when W2
        // cannot infer one, so these rows decide catalog data through the
        // proposal flow. They are read from the same code seed the catalog uses.
        expect(defaultOf('gemini-4-hydrogen') === 'high', 'hydrogen default high');
        expect(defaultOf('gemini-4-argon') === 'medium', 'argon default medium');
        expect(defaultOf('gemini-4-carbon') === 'medium', 'carbon default medium');
        expect(defaultOf('gpt-6-astra') === 'medium', 'astra default medium');
        expect(defaultOf('gpt-6-luna') === 'medium', 'luna default medium');
        expect(defaultOf('gpt-6-sol') === 'medium', 'sol default medium');
        expect(defaultOf('claude-sonnet-5-5') === 'high', 'sonnet default high');
        expect(defaultOf('claude-opus-5-5') === 'high', 'Opus 5.5 default comes from the seed (high)');
        expect(defaultOf('grok-4.7') === 'high', 'grok-4.7 default high');
        expect(defaultOf('deepseek-flash') === 'high', 'deepseek default high');
        expect(JSON.stringify(effortsOf('gpt-6-sol')) === JSON.stringify(['none', 'low', 'medium', 'high', 'xhigh', 'max']), 'sol keeps its seeded graded efforts');
        expect(effortsOf('mimo-v2.6-flash').length === 0 && specOf('mimo-v2.6-flash')?.vendorToggle === true, 'mimo stays toggle-only');
    }));

    results.push(await runCase('cost estimate uses the wave token cap and the model price', () => {
        const hydrogen = PROBE_MODEL_SNAPSHOT.find((model) => model.model === 'gemini-4-hydrogen');
        expect(hydrogen !== undefined, 'snapshot has hydrogen');
        if (hydrogen === undefined) return;
        const w1 = estimateRequestCostUsd(hydrogen, 'w1');
        const w2 = estimateRequestCostUsd(hydrogen, 'w2');
        expect(w2 > w1, 'the effect wave reserves more output tokens');
        expect(w1 > 0 && w1 < 0.01, `W1 request estimate ${w1} stays tiny`);
    }));

    results.push(await runCase('w2 output cap: default stays 4096 and the bounds are enforced', () => {
        expect(W2_OUTPUT_TOKEN_CAP === 4_096, 'the default W2 cap is 4096');
        expect(MIN_W2_OUTPUT_TOKEN_CAP === 1_024 && MAX_W2_OUTPUT_TOKEN_CAP === 16_384, 'the documented bounds');
        expect(defaultBudget('w2').w2OutputTokenCap === undefined, 'the default budget carries no override');
        const base = buildProbePlan({ wave: 'w2', budget: defaultBudget('w2') });
        const explicitDefault = buildProbePlan({ wave: 'w2', budget: { ...defaultBudget('w2'), w2OutputTokenCap: W2_OUTPUT_TOKEN_CAP } });
        expect(base.requests === 49 && explicitDefault.requests === 49, `49 W2 requests (got ${base.requests}/${explicitDefault.requests})`);
        expect(base.estimatedUsd === 1.325087, `the default W2 estimate is unchanged (${base.estimatedUsd})`);
        expect(explicitDefault.estimatedUsd === base.estimatedUsd, 'an explicit 4096 is the same plan');
        for (const valid of [1_024, W2_OUTPUT_TOKEN_CAP, 6_144, 8_192, MAX_W2_OUTPUT_TOKEN_CAP]) {
            expect(isValidW2OutputTokenCap(valid), `${valid} is a valid cap`);
        }
        for (const invalid of [1_023, MAX_W2_OUTPUT_TOKEN_CAP + 1, 4_096.5, 0, -1_024, Number.NaN]) {
            expect(!isValidW2OutputTokenCap(invalid), `${String(invalid)} is refused`);
        }
        expect(W1_OUTPUT_TOKEN_CAP === 256, 'the W1 cap stays untouched');
    }));

    results.push(await runCase('w2 output cap: raising it raises the estimate and the all-wave worst case', () => {
        const planAt = (cap: number | undefined) =>
            buildProbePlan({
                wave: 'w2',
                budget: { ...defaultBudget('w2'), ...(cap === undefined ? {} : { w2OutputTokenCap: cap }) },
            });
        const base = planAt(undefined);
        const lower = planAt(1_024);
        const mid = planAt(6_144);
        const high = planAt(8_192);
        expect(lower.estimatedUsd === 0.347085, `1024 lowers the estimate (${lower.estimatedUsd})`);
        expect(base.estimatedUsd === 1.325087, `4096 baseline (${base.estimatedUsd})`);
        expect(mid.estimatedUsd === 1.977088, `6144 estimate (${mid.estimatedUsd})`);
        expect(high.estimatedUsd === 2.629089, `8192 estimate (${high.estimatedUsd})`);
        expect(lower.estimatedUsd < base.estimatedUsd && base.estimatedUsd < mid.estimatedUsd && mid.estimatedUsd < high.estimatedUsd, 'the estimate grows with the cap');
        for (const plan of [lower, base, mid, high]) expect(plan.requests === 49, 'the cap changes cost, never the request count');
        const allBase = buildProbePlan({ wave: 'all', budget: defaultBudget('all') });
        const allRaised = buildProbePlan({ wave: 'all', budget: { ...defaultBudget('all'), w2OutputTokenCap: 8_192 } });
        expect(allBase.estimatedUsd === 1.742597 && allBase.requests === 149, `default all-wave ${allBase.estimatedUsd}/${allBase.requests}`);
        expect(allRaised.estimatedUsd > allBase.estimatedUsd, 'the raised cap raises the all-wave worst case');
        // The per-request formula follows the cap: hydrogen output is $7.5/M tokens.
        const hydrogen = PROBE_MODEL_SNAPSHOT.find((model) => model.model === 'gemini-4-hydrogen');
        expect(hydrogen !== undefined, 'hydrogen in snapshot');
        if (hydrogen !== undefined) {
            const delta = estimateRequestCostUsd(hydrogen, 'w2', 6_144) - estimateRequestCostUsd(hydrogen, 'w2');
            expect(Math.abs(delta - (2_048 * 7.5) / 1_000_000) < 1e-12, `6144 reserves 2048 more output tokens (Δ=${delta})`);
            expect(
                estimateRequestCostUsd(hydrogen, 'w1', 6_144) === estimateRequestCostUsd(hydrogen, 'w1'),
                'the W2 cap never touches a W1 estimate'
            );
        }
    }));

    results.push(await runCase('w2 output cap: the --max-usd cut follows the raised estimate', () => {
        const fitting = buildProbePlan({ wave: 'w2', budget: { ...defaultBudget('w2'), maxUsd: 2 } });
        expect(fitting.cut.droppedRequests === 0 && fitting.estimatedUsd === 1.325087, 'the default cap fits $2 untouched');
        const raised = buildProbePlan({ wave: 'w2', budget: { ...defaultBudget('w2'), maxUsd: 2, w2OutputTokenCap: 16_384 } });
        expect(raised.cut.droppedRequests > 0, `the raised cap hits the dollar limit (dropped ${raised.cut.droppedRequests})`);
        expect(raised.cut.reasons.includes('--max-usd 2.00'), `the cut reason names the limit (${raised.cut.reasons.join(',')})`);
        expect(raised.estimatedUsd <= 2, 'the kept plan stays inside the budget');
        const allRaised = buildProbePlan({ wave: 'all', budget: { ...defaultBudget('all'), w2OutputTokenCap: 8_192 } });
        expect(allRaised.cut.droppedRequests === 1, `the all-wave default budget cuts one sample (got ${allRaised.cut.droppedRequests})`);
        expect(allRaised.cut.reasons.includes('--max-usd 3.00'), 'the all-wave cut names $3.00');
        expect(allRaised.requests === 148 && allRaised.estimatedUsd === 2.881559, `kept plan ${allRaised.requests}/${allRaised.estimatedUsd}`);
    }));

    results.push(await runCase('w2 output cap: the CLI parses the switch, refuses bad values and names it in --help', () => {
        const parsed = parseProbeCliArguments(['--wave', 'w2', '--w2-cap', '6144', '--dry-run']);
        expect(parsed.w2Cap === 6_144 && parsed.wave === 'w2' && parsed.yes === false, 'the switch parses');
        const inline = parseProbeCliArguments(['--w2-cap=8192']);
        expect(inline.w2Cap === 8_192, 'an inline value parses too');
        expect(parseProbeCliArguments([]).w2Cap === undefined, 'omitted keeps the default');
        expect(parseProbeCliArguments(['--w2-cap', '1024']).w2Cap === 1_024, 'the lower bound parses');
        expect(parseProbeCliArguments(['--w2-cap', '16384']).w2Cap === 16_384, 'the upper bound parses');
        const messageOf = (raw: string): string => {
            try {
                parseProbeCliArguments(['--w2-cap', raw]);
                return '';
            } catch (error) {
                return error instanceof Error ? error.message : String(error);
            }
        };
        for (const bad of ['999', '16385', '4096.5', '-1024', 'abc']) {
            const message = messageOf(bad);
            expect(message.includes('1024..16384'), `--w2-cap ${bad} is refused (${message})`);
        }
        expect(PROBE_HELP.includes('--w2-cap'), '--help lists the switch');
        expect(PROBE_HELP.includes('1024..16384'), '--help names the range');
        expect(PROBE_HELP.includes('4096'), '--help names the default');
        expect(PROBE_HELP.includes('生产不设该上限'), '--help says production sends no such cap');
        expect(PROBE_HELP.includes('更少截断但成本增加'), '--help states the tradeoff');
    }));

    results.push(await runCase('--models and --models-json restrict the matrix', () => {
        const narrowed = buildProbePlan({ wave: 'w1', budget: defaultBudget('w1'), models: ['deepseek-flash'] });
        expect(narrowed.candidates.length === 9, `deepseek only (got ${narrowed.candidates.length})`);
        const parsed = parseModelsJson([
            {
                model: 'gemini-4-hydrogen',
                platform: 'gemini',
                price: { inputPerMillionUsd: 1.5, outputPerMillionUsd: 7.5 },
                vendorEfforts: ['low', 'high'],
                vendorDefaultEffort: 'high',
            },
        ]);
        expect(parsed.problems.length === 0, 'valid external snapshot parses');
        const external = buildProbePlan({ wave: 'w1', budget: defaultBudget('w1'), modelSpecs: parsed.models });
        expect(external.models.length === 1 && external.models[0]?.model === 'gemini-4-hydrogen', 'external snapshot replaces the list');
        const broken = parseModelsJson([{ model: 'x', platform: 'nope' }, { model: 'y', platform: 'openai' }]);
        expect(broken.problems.length === 2, 'two broken entries are reported');
    }));
};

// ---------------------------------------------------------------------------
// 2. Request bodies: no paid tools, one thinking parameter per platform
// ---------------------------------------------------------------------------

const buildOptions = { maxOutputTokens: 256, prompt: 'probe', timeoutMs: 5_000 };

/** Read a nested JSON value from a captured request without a cast */
const nested = (value: unknown, key: string): unknown =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))[key]
        : undefined;

const PAID_TOOL_MARKERS = ['web_search', 'x_search', 'code_interpreter', 'googleSearch', 'urlContext', 'google_search', 'imageSearch'];

const wireBodiesOf = (): Array<{ readonly label: string; readonly body: string }> => {
    const bodies: Array<{ label: string; body: string }> = [];
    for (const platform of ['gemini', 'openai', 'anthropic', 'grok', 'deepseek', 'mimo'] as const) {
        for (const seed of [
            { variant: 'baseline' as const, effort: null },
            { variant: 'level' as const, effort: 'high' as const },
            { variant: 'level' as const, effort: 'xhigh' as const },
            { variant: 'toggle-off' as const, effort: null },
            { variant: 'toggle-on' as const, effort: null },
            { variant: 'budget' as const, effort: null },
            { variant: 'invalid-shape' as const, effort: null },
        ]) {
            for (const withClientTools of [false, true]) {
                const candidate = candidateOf(platform, 'model-x', seed.variant, seed.effort, { withClientTools });
                const body =
                    platform === 'gemini'
                        ? JSON.stringify(buildGeminiParams(candidate, buildOptions))
                        : platform === 'openai'
                          ? JSON.stringify(buildOpenAiResponsesParams(candidate, buildOptions))
                          : platform === 'anthropic'
                            ? JSON.stringify(buildAnthropicParams(candidate, buildOptions))
                            : platform === 'grok'
                              ? JSON.stringify(buildGrokResponsesParams(candidate, buildOptions))
                              : JSON.stringify(buildChatParams(candidate, buildOptions));
                bodies.push({ label: `${platform}:${seed.variant}:${seed.effort ?? 'auto'}:tools=${withClientTools}`, body });
            }
        }
    }
    return bodies;
};

const runWireBodyCases = async (): Promise<void> => {
    results.push(await runCase('no probe request carries a paid built-in tool', () => {
        for (const { label, body } of wireBodiesOf()) {
            for (const marker of PAID_TOOL_MARKERS) {
                expect(!body.includes(marker), `${label} must not mention ${marker}`);
            }
        }
    }));

    results.push(await runCase('only the fidelity variant declares a client function tool', () => {
        for (const { label, body } of wireBodiesOf()) {
            if (label.endsWith('tools=false')) {
                expect(!body.includes('probe_echo'), `${label} declares no tool`);
            } else {
                expect(body.includes('probe_echo'), `${label} declares the client function tool`);
            }
        }
    }));

    results.push(await runCase('Gemini: baseline has no level, HIGH is the native enum, XHIGH rides extraBody', () => {
        const baseline = JSON.stringify(buildGeminiParams(candidateOf('gemini', 'gemini-4-hydrogen', 'baseline', null), buildOptions));
        expect(!baseline.includes('thinkingLevel'), 'baseline sends no thinkingLevel');
        expect(baseline.includes('includeThoughts'), 'baseline still asks for thoughts');
        const high = JSON.stringify(buildGeminiParams(candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'high'), buildOptions));
        expect(high.includes('"thinkingLevel":"HIGH"'), 'HIGH goes through the SDK enum');
        const xhigh = JSON.stringify(buildGeminiParams(candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'xhigh'), buildOptions));
        expect(xhigh.includes('"extraBody"') && xhigh.includes('XHIGH'), 'XHIGH needs httpOptions.extraBody (enum lacks it)');
        const budget = JSON.stringify(buildGeminiParams(candidateOf('gemini', 'gemini-4-hydrogen', 'budget', null), buildOptions));
        expect(budget.includes('thinkingBudget'), 'the budget sentinel is present');
        // A pre-Gemini-4 model keeps production's automatic budget as its
        // baseline (gemini-platform.ts prepareRequest: no gemini-4 prefix).
        const legacy = JSON.stringify(buildGeminiParams(candidateOf('gemini', 'gemini-3.8-flash', 'baseline', null), buildOptions));
        expect(legacy.includes('"thinkingBudget":-1') && !legacy.includes('thinkingLevel'), 'a pre-Gemini-4 baseline sends the automatic budget');
    }));

    results.push(await runCase('OpenAI: baseline keeps the summary, effort appears only on the level variant', () => {
        const baseline = buildOpenAiResponsesParams(candidateOf('openai', 'gpt-6-luna', 'baseline', null), buildOptions);
        expect(baseline.reasoning?.summary === 'detailed' && baseline.reasoning?.effort === undefined, 'baseline sends summary without effort');
        const high = buildOpenAiResponsesParams(candidateOf('openai', 'gpt-6-luna', 'level', 'high'), buildOptions);
        expect(high.reasoning?.effort === 'high', 'level variant sends the effort');
        expect(high.max_output_tokens === 256, 'the token cap is reserved');
    }));

    results.push(await runCase('Grok: 4.7 stays silent, multi-agent keeps the production default high', () => {
        const baseline = buildGrokResponsesParams(candidateOf('grok', 'grok-4.7', 'baseline', null), buildOptions);
        expect(baseline.reasoning === undefined, '4.7 baseline has no reasoning field');
        const level = buildGrokResponsesParams(candidateOf('grok', 'grok-4.7', 'level', 'xhigh'), buildOptions);
        expect(level.reasoning?.effort === 'xhigh', 'level sends reasoning.effort');
        // Production sends effort high on multi-agent models in its default mode
        // too (grok-platform.ts via grokReasoningFor), so the baseline must too.
        const multiBaseline = buildGrokResponsesParams(candidateOf('grok', 'grok-4.20-multi-agent-0309', 'baseline', null), buildOptions);
        expect(multiBaseline.reasoning?.effort === 'high', 'multi-agent baseline mirrors the production default high');
        const multi = buildGrokResponsesParams(candidateOf('grok', 'grok-4.20-multi-agent-0309', 'level', 'high'), buildOptions);
        expect(multi.max_output_tokens === undefined, 'multi-agent does not support max_tokens');
        expect(multi.reasoning?.effort === 'high', 'multi-agent level sends the requested effort');
    }));

    results.push(await runCase('Anthropic: adaptive thinking always, effort under output_config', () => {
        const baseline = buildAnthropicParams(candidateOf('anthropic', 'claude-sonnet-5-5', 'baseline', null), buildOptions);
        expect(baseline.thinking?.type === 'adaptive', 'adaptive thinking is always requested');
        expect(baseline.output_config === undefined, 'baseline sends no output_config');
        const level = buildAnthropicParams(candidateOf('anthropic', 'claude-sonnet-5-5', 'level', 'xhigh'), buildOptions);
        expect(level.output_config?.effort === 'xhigh', 'level sends output_config.effort');
        const minimal = buildAnthropicParams(candidateOf('anthropic', 'claude-sonnet-5-5', 'level', 'minimal'), buildOptions);
        expect(JSON.stringify(minimal).includes('"effort":"minimal"'), 'the negative sentinel reaches the wire as-is');
    }));

    results.push(await runCase('DeepSeek: level sends the production thinking switch plus reasoning_effort', () => {
        const level = buildChatParams(candidateOf('deepseek', 'deepseek-flash', 'level', 'high'), buildOptions);
        expect(level.reasoning_effort === 'high', 'level sends reasoning_effort');
        expect(level.thinking?.type === 'enabled', 'level also sends thinking.type=enabled like production');
        const baseline = buildChatParams(candidateOf('deepseek', 'deepseek-flash', 'baseline', null), buildOptions);
        expect(baseline.thinking === undefined && baseline.reasoning_effort === undefined, 'default sends no thinking params');
        const off = buildChatParams(candidateOf('deepseek', 'deepseek-flash', 'toggle-off', null), buildOptions);
        expect(off.thinking?.type === 'disabled', 'toggle-off sends thinking.type=disabled');
    }));

    results.push(await runCase('MiMo: production always sends the switch; a graded effort is best-effort', () => {
        // Production sends thinking.type=enabled for its default mode too
        // (mimo-platform.ts thinkingParamsOf), so the baseline mirrors it.
        const baseline = buildChatParams(candidateOf('mimo', 'mimo-v2.6-flash', 'baseline', null), buildOptions);
        expect(baseline.thinking?.type === 'enabled', 'baseline mirrors the production always-enabled switch');
        const on = buildChatParams(candidateOf('mimo', 'mimo-v2.6-flash', 'toggle-on', null), buildOptions);
        expect(on.thinking?.type === 'enabled', 'toggle-on sends enabled');
        const off = buildChatParams(candidateOf('mimo', 'mimo-v2.6-flash', 'toggle-off', null), buildOptions);
        expect(off.thinking?.type === 'disabled', 'toggle-off sends disabled');
        const invalid = buildChatParams(candidateOf('mimo', 'mimo-v2.6-flash', 'invalid-shape', null), buildOptions);
        expect(invalid.thinking?.type === 'low', 'the invalid-shape sentinel sends thinking.type=low');
        // Production's graded wire on MiMo is best-effort: it sends
        // reasoning_effort and falls back on a 400. A level candidate (external
        // --models-json snapshot) must send the same shape.
        const level = buildChatParams(candidateOf('mimo', 'mimo-v2.6-flash', 'level', 'high'), buildOptions);
        expect(level.thinking?.type === 'enabled', 'a graded MiMo candidate keeps the switch on');
        expect(level.reasoning_effort === 'high', 'a graded MiMo candidate sends reasoning_effort like production');
    }));

    results.push(await runCase('production parity: tool-round fidelity variants carry the same thinking params', () => {
        // The production tool loops send the thinking parameter on every round,
        // the round that declares function tools included (task-8 wire). The
        // fidelity variant is that round's shape.
        const openaiBaseline = buildOpenAiResponsesParams(
            candidateOf('openai', 'gpt-6.1-sol', 'baseline', null, { withClientTools: true }),
            buildOptions
        );
        expect(
            openaiBaseline.reasoning?.summary === 'detailed' && openaiBaseline.reasoning?.effort === undefined,
            'an OpenAI tool round in the default mode sends the summary alone'
        );
        const openaiLevel = buildOpenAiResponsesParams(
            candidateOf('openai', 'gpt-6-luna', 'level', 'high', { withClientTools: true }),
            buildOptions
        );
        expect(
            openaiLevel.reasoning?.effort === 'high' && openaiLevel.reasoning?.summary === 'detailed' && openaiLevel.tools !== undefined,
            'an OpenAI tool round with an explicit effort sends both'
        );
        const anthropicLevel = buildAnthropicParams(
            candidateOf('anthropic', 'claude-sonnet-5-5', 'level', 'high', { withClientTools: true }),
            buildOptions
        );
        expect(
            anthropicLevel.thinking?.type === 'adaptive' && anthropicLevel.output_config?.effort === 'high' && anthropicLevel.tools !== undefined,
            'an Anthropic tool round keeps adaptive thinking plus output_config.effort'
        );
        const geminiLevel = buildGeminiParams(
            candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'xhigh', { withClientTools: true }),
            buildOptions
        );
        expect(
            JSON.stringify(geminiLevel).includes('extraBody') && JSON.stringify(geminiLevel).includes('probe_echo'),
            'a Gemini tool round combines the XHIGH level with the function declaration'
        );
        const deepseekLevel = buildChatParams(
            candidateOf('deepseek', 'deepseek-flash', 'level', 'high', { withClientTools: true }),
            buildOptions
        );
        expect(
            deepseekLevel.thinking?.type === 'enabled' && deepseekLevel.reasoning_effort === 'high' && deepseekLevel.tools !== undefined,
            'a DeepSeek tool round keeps the switch and the graded effort'
        );
        const mimoOn = buildChatParams(
            candidateOf('mimo', 'mimo-v2.6-flash', 'toggle-on', null, { withClientTools: true }),
            buildOptions
        );
        expect(
            mimoOn.thinking?.type === 'enabled' && mimoOn.tools !== undefined,
            'a MiMo tool round keeps the enabled switch'
        );
    }));
};

// ---------------------------------------------------------------------------
// 3. Wire parsing through the real SDK clients with a scripted fetch
// ---------------------------------------------------------------------------

const geminiChunk = (thoughts: number): string =>
    [
        { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking…', thought: true }] } }] },
        {
            candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 12, thoughtsTokenCount: thoughts, totalTokenCount: 112 + thoughts },
        },
    ]
        .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
        .join('');

const responsesEvent = (payload: Record<string, unknown>): string => `event: ${String(payload['type'])}\ndata: ${JSON.stringify(payload)}\n\n`;

const responsesReply = (reasoningTokens: number): ScriptedReply =>
    sse(
        responsesEvent({
            type: 'response.reasoning_summary_text.delta',
            item_id: 'rs_1',
            output_index: 0,
            summary_index: 0,
            delta: 'thinking…',
        }) +
            responsesEvent({
                type: 'response.output_text.delta',
                item_id: 'msg_1',
                output_index: 1,
                content_index: 0,
                delta: 'ok',
            }) +
            responsesEvent({
                type: 'response.completed',
                response: {
                    id: 'resp_1',
                    object: 'response',
                    created_at: 0,
                    status: 'completed',
                    model: 'offline',
                    output: [],
                    usage: {
                        input_tokens: 100,
                        output_tokens: 12 + reasoningTokens,
                        total_tokens: 112 + reasoningTokens,
                        output_tokens_details: { reasoning_tokens: reasoningTokens },
                    },
                },
            })
    );

const anthropicReply = (thinkingTokens: number): ScriptedReply =>
    sse(
        [
            {
                type: 'message_start',
                message: {
                    id: 'msg_1',
                    type: 'message',
                    role: 'assistant',
                    model: 'offline',
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 100, output_tokens: 0 },
                },
            },
            { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thinking…' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ok' } },
            { type: 'content_block_stop', index: 1 },
            {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { output_tokens: 12 + thinkingTokens, output_tokens_details: { thinking_tokens: thinkingTokens } },
            },
            { type: 'message_stop' },
        ]
            .map((event) => responsesEvent(event))
            .join('')
    );

const chatReply = (reasoningTokens: number): ScriptedReply => {
    const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): string =>
        `data: ${JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'offline',
            choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
    return sse(
        chunk({ reasoning_content: 'thinking…' }) +
            chunk({ content: 'ok' }) +
            chunk({}, 'stop') +
            `data: ${JSON.stringify({
                id: 'chatcmpl-1',
                object: 'chat.completion.chunk',
                created: 0,
                model: 'offline',
                choices: [],
                usage: {
                    prompt_tokens: 100,
                    completion_tokens: 12 + reasoningTokens,
                    total_tokens: 112 + reasoningTokens,
                    completion_tokens_details: { reasoning_tokens: reasoningTokens },
                },
            })}\n\n` +
            'data: [DONE]\n\n'
    );
};

const runLaneCases = async (): Promise<void> => {
    results.push(await runCase('Gemini lane: parse thoughts tokens and the thought parts', async () => {
        const candidate = candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'high');
        const { lane, requests } = laneWithScriptedReplies('gemini', [sse(geminiChunk(240))]);
        const observation = await lane.send(candidate, { maxOutputTokens: 256, timeoutMs: 5_000 });
        expect(observation.outcome === 'accepted', `accepted (got ${observation.outcome}/${observation.errorClass ?? ''})`);
        expect(observation.status === 200, 'status 200');
        expect(observation.inputTokens === 100, 'prompt tokens parsed');
        expect(observation.reasoningTokens === 240, 'thoughtsTokenCount parsed');
        expect(observation.outputTokens === 252, 'billable output = candidates + thoughts');
        expect(observation.thinkingChars === 9, `thinking chars counted (got ${observation.thinkingChars})`);
        expect(observation.textChars === 2, 'text chars counted');
        expect(observation.finishReason === 'STOP', 'finish reason parsed');
        expect(requests.length === 1, 'exactly one request');
        const config = requests[0]?.body['generationConfig'];
        expect(JSON.stringify(config).includes('HIGH'), 'the request carried the level');
    }));

    results.push(await runCase('Gemini lane: XHIGH only exists through extraBody and reaches the wire', async () => {
        const xhigh = candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'xhigh');
        const { lane, requests } = laneWithScriptedReplies('gemini', [sse(geminiChunk(12))]);
        const observation = await lane.send(xhigh, { maxOutputTokens: 256, timeoutMs: 5_000 });
        expect(observation.outcome === 'accepted', `accepted (got ${observation.outcome}/${observation.errorClass ?? ''})`);
        const body = requests[0]?.body;
        const generationConfig = nested(body, 'generationConfig');
        const thinkingConfig = nested(generationConfig, 'thinkingConfig');
        expect(nested(thinkingConfig, 'thinkingLevel') === 'XHIGH', `the merged wire body carries XHIGH (got ${String(nested(thinkingConfig, 'thinkingLevel'))})`);
        expect(nested(thinkingConfig, 'includeThoughts') === true, 'includeThoughts survives the extraBody merge');
        // Production sends the same generationConfig.thinkingConfig shape, with
        // the level field set directly (src/ai/platforms/gemini-platform.ts
        // THINKING_LEVEL_XHIGH); the SDK deep-merges extraBody, so the rest of
        // the generationConfig must survive exactly as the probe built it.
        expect(nested(generationConfig, 'maxOutputTokens') === 256, `the token cap survives the extraBody merge (got ${String(nested(generationConfig, 'maxOutputTokens'))})`);
        expect(nested(generationConfig, 'thinkingBudget') === undefined, 'the XHIGH request must not carry a thinkingBudget');
        const baseline = candidateOf('gemini', 'gemini-4-hydrogen', 'baseline', null);
        const baselineScripted = laneWithScriptedReplies('gemini', [sse(geminiChunk(12))]);
        await baselineScripted.lane.send(baseline, { maxOutputTokens: 256, timeoutMs: 5_000 });
        const baselineConfig = nested(nested(baselineScripted.requests[0]?.body, 'generationConfig'), 'thinkingConfig');
        expect(nested(baselineConfig, 'thinkingLevel') === undefined, 'baseline sends no level at all');
    }));

    results.push(await runCase('Gemini lane: 400 unsupported level becomes rejected_effort, not an error', async () => {
        const candidate = candidateOf('gemini', 'gemini-4-argon', 'level', 'xhigh');
        const observation = await drainLane('gemini', candidate, jsonReply(400, { error: { code: 400, message: 'Thinking level is unsupported: THINKING_LEVEL_XHIGH' } }));
        expect(observation.outcome === 'rejected', `rejected (got ${observation.outcome})`);
        expect(observation.errorClass === 'rejected_effort', `rejected_effort (got ${observation.errorClass})`);
        expect(observation.status === 400, 'status recorded');
        expect(observation.reasoningTokens === null, 'no usage on a rejection');
    }));

    results.push(await runCase('Gemini lane: a token-cap stop is accepted, never a rejection', async () => {
        const candidate = candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'xhigh');
        const truncated = `data: ${JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: 'still thinking', thought: true }] }, finishReason: 'MAX_TOKENS' }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 0, thoughtsTokenCount: 256, totalTokenCount: 356 },
        })}\n\n`;
        const observation = await drainLane('gemini', candidate, sse(truncated));
        expect(observation.outcome === 'accepted', `a truncated 2xx is accepted (got ${observation.outcome}/${observation.errorClass ?? ''})`);
        expect(observation.finishReason === 'MAX_TOKENS', `the stop reason is recorded (got ${String(observation.finishReason)})`);
        expect(observation.reasoningTokens === 256, 'the thinking tokens before the cut are billed');
        // The probe cap is a budget guard (production sends no Gemini cap); a
        // truncated sample must never be read as "the effort was rejected".
        expect(observation.errorClass === null, 'no error class on a truncated 2xx');
    }));

    results.push(await runCase('lane: the probe cap is flagged truncated in the evidence, a closed answer is not', async () => {
        const candidate = candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'xhigh');
        const capped = `data: ${JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: 'still thinking', thought: true }] }, finishReason: 'MAX_TOKENS' }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 0, thoughtsTokenCount: 256, totalTokenCount: 356 },
        })}\n\n`;
        const cappedObservation = await drainLane('gemini', candidate, sse(capped));
        expect(cappedObservation.finishReason === 'MAX_TOKENS', 'the stop reason is recorded');
        expect(isTokenCapFinishReason(cappedObservation.finishReason), 'the token cap is recognised');
        expect(JSON.stringify(cappedObservation).includes('"truncated":true'), 'the observation records the cut for observations.json');
        const closedObservation = await drainLane('gemini', candidate, sse(geminiChunk(40)));
        expect(JSON.stringify(closedObservation).includes('"truncated":false'), 'a closed answer is not flagged');
        expect(isTokenCapFinishReason('length') && !isTokenCapFinishReason('stop') && !isTokenCapFinishReason(null), 'chat length and normal stop are classified');
    }));

    results.push(await runCase('OpenAI lane: request carries the effort and usage is parsed', async () => {
        const candidate = candidateOf('openai', 'gpt-6-luna', 'level', 'xhigh');
        const { lane, requests } = laneWithScriptedReplies('openai', [responsesReply(777)]);
        const observation = await lane.send(candidate, { maxOutputTokens: 256, timeoutMs: 5_000 });
        expect(observation.outcome === 'accepted', `accepted (got ${observation.outcome}/${observation.errorClass ?? ''})`);
        expect(observation.reasoningTokens === 777, 'reasoning tokens parsed');
        expect(observation.outputTokens === 789, 'output tokens parsed');
        const reasoning = requests[0]?.body['reasoning'];
        expect(JSON.stringify(reasoning).includes('xhigh'), 'request carried effort xhigh');
        expect(JSON.stringify(reasoning).includes('detailed'), 'request kept summary detailed');
    }));

    results.push(await runCase('OpenAI lane: unsupported parameter is rejected_effort', async () => {
        const candidate = candidateOf('openai', 'gpt-6-astra', 'level', 'none');
        const observation = await drainLane(
            'openai',
            candidate,
            jsonReply(400, { error: { message: "Unsupported parameter: 'reasoning.effort'", type: 'invalid_request_error' } })
        );
        expect(observation.errorClass === 'rejected_effort', `rejected_effort (got ${observation.errorClass})`);
    }));

    results.push(await runCase('Anthropic lane: output_config.effort is sent and thinking tokens are parsed', async () => {
        const candidate = candidateOf('anthropic', 'claude-sonnet-5-5', 'level', 'xhigh');
        const { lane, requests } = laneWithScriptedReplies('anthropic', [anthropicReply(321)]);
        const observation = await lane.send(candidate, { maxOutputTokens: 256, timeoutMs: 5_000 });
        expect(observation.outcome === 'accepted', `accepted (got ${observation.outcome}/${observation.errorClass ?? ''})`);
        expect(observation.reasoningTokens === 321, 'thinking_tokens parsed from output_tokens_details');
        expect(observation.outputTokens === 333, 'output tokens parsed');
        const outputConfig = requests[0]?.body['output_config'];
        expect(JSON.stringify(outputConfig).includes('xhigh'), 'request carried output_config.effort');
        const thinking = requests[0]?.body['thinking'];
        expect(JSON.stringify(thinking).includes('adaptive'), 'adaptive thinking was requested');
    }));

    results.push(await runCase('Anthropic lane: invalid effort value is rejected_effort', async () => {
        const candidate = candidateOf('anthropic', 'claude-sonnet-5-5', 'level', 'minimal');
        const observation = await drainLane(
            'anthropic',
            candidate,
            jsonReply(400, {
                error: {
                    type: 'invalid_request_error',
                    message: "output_config.effort: Input should be 'low', 'medium', 'high', 'xhigh' or 'max'",
                },
            })
        );
        expect(observation.errorClass === 'rejected_effort', `rejected_effort (got ${observation.errorClass})`);
    }));

    results.push(await runCase('Grok lane: reasoning.effort is sent and parsed', async () => {
        const candidate = candidateOf('grok', 'grok-4.7', 'level', 'xhigh');
        const { lane, requests } = laneWithScriptedReplies('grok', [responsesReply(456)]);
        const observation = await lane.send(candidate, { maxOutputTokens: 256, timeoutMs: 5_000 });
        expect(observation.outcome === 'accepted', `accepted (got ${observation.outcome}/${observation.errorClass ?? ''})`);
        expect(observation.reasoningTokens === 456, 'reasoning tokens parsed');
        expect(JSON.stringify(requests[0]?.body['reasoning']).includes('xhigh'), 'request carried reasoning.effort');
    }));

    results.push(await runCase('DeepSeek lane: reasoning_content and usage are parsed', async () => {
        const candidate = candidateOf('deepseek', 'deepseek-flash', 'level', 'high');
        const { lane, requests } = laneWithScriptedReplies('deepseek', [chatReply(123)]);
        const observation = await lane.send(candidate, { maxOutputTokens: 256, timeoutMs: 5_000 });
        expect(observation.outcome === 'accepted', `accepted (got ${observation.outcome}/${observation.errorClass ?? ''})`);
        expect(observation.reasoningTokens === 123, 'reasoning tokens parsed');
        expect(observation.thinkingChars === 9, 'reasoning_content chars counted');
        expect(observation.inputTokens === 100, 'prompt tokens parsed');
        expect(requests[0]?.body['reasoning_effort'] === 'high', 'request carried reasoning_effort');
    }));

    results.push(await runCase('MiMo lane: the toggle reaches the wire and is parsed', async () => {
        const candidate = candidateOf('mimo', 'mimo-v2.6-flash', 'toggle-on', null);
        const { lane, requests } = laneWithScriptedReplies('mimo', [chatReply(88)]);
        const observation = await lane.send(candidate, { maxOutputTokens: 256, timeoutMs: 5_000 });
        expect(observation.outcome === 'accepted', `accepted (got ${observation.outcome}/${observation.errorClass ?? ''})`);
        expect(observation.reasoningTokens === 88, 'reasoning tokens parsed');
        expect(JSON.stringify(requests[0]?.body['thinking']).includes('enabled'), 'request carried thinking.type=enabled');
    }));

    results.push(await runCase('lane 401 is auth_error and never counts as an effort rejection', async () => {
        const candidate = candidateOf('openai', 'gpt-6-luna', 'level', 'xhigh');
        const observation = await drainLane(
            'openai',
            candidate,
            jsonReply(401, { error: { message: 'Invalid API key: reasoning.effort is unsupported', code: 'invalid_api_key' } })
        );
        expect(observation.errorClass === 'auth_error', `auth_error (got ${observation.errorClass})`);
        expect(observation.errorClass !== 'rejected_effort', 'auth is never a rejection');
        expect(observation.outcome === 'error', `outcome error (got ${observation.outcome})`);
    }));

    results.push(await runCase('lane 429 is rate_limited even when the body mentions effort', async () => {
        const candidate = candidateOf('openai', 'gpt-6-luna', 'level', 'high');
        const observation = await drainLane('openai', candidate, jsonReply(429, { error: { message: 'rate limit exceeded for reasoning.effort' } }));
        expect(observation.errorClass === 'rate_limited', `rate_limited (got ${observation.errorClass})`);
    }));

    results.push(await runCase('lane network failure becomes network_error', async () => {
        const candidate = candidateOf('deepseek', 'deepseek-flash', 'level', 'low');
        const fetch: ProbeFetch = () => {
            throw new TypeError('fetch failed: ECONNRESET');
        };
        const lanes = createProbeLanes(testEnvironment(), { fetch, lanes: fixtureLaneConfigurations() });
        const observation = await lanes.deepseek.send(candidate, { maxOutputTokens: 256, timeoutMs: 5_000 });
        expect(observation.errorClass === 'network_error', `network_error (got ${observation.errorClass})`);
        expect(observation.status === null, 'no status on a transport failure');
    }));

    results.push(await runCase('lane evidence redacts the credentials it was given', async () => {
        const environment = testEnvironment();
        const secret = 'offline-openai-key';
        const candidate = candidateOf('openai', 'gpt-6-luna', 'level', 'high');
        const observation = await drainLane(
            'openai',
            candidate,
            jsonReply(401, { error: { message: `Incorrect API key provided: ${secret}. reasoning is required` } })
        );
        const redactor = redactorOf(environment);
        expect(!observation.errorSummary?.includes(secret), 'the error summary does not echo the key');
        expect(!observation.responseExcerpt.includes(secret), 'the response excerpt does not echo the key');
        expect(redactor(secret) === '<redacted>', 'the environment redactor knows this key');
    }));
};

// ---------------------------------------------------------------------------
// 4. Error classification (pure matrix)
// ---------------------------------------------------------------------------

const runClassificationCases = async (): Promise<void> => {
    const classify = (
        platform: ProbePlatform,
        status: number | null,
        raw: string,
        options: { readonly thrownMessage?: string; readonly duringStream?: boolean } = {}
    ) => classifyProbeError({ platform, status, raw, ...options });

    results.push(await runCase('classifier: status codes outrank effort-looking text', () => {
        const expecting = (status: number, expected: string): void => {
            const result = classify('openai', status, 'reasoning.effort is unsupported and invalid');
            expect(result.errorClass === expected, `status ${status} → ${expected} (got ${result.errorClass})`);
        };
        expecting(401, 'auth_error');
        expecting(403, 'auth_error');
        expecting(404, 'model_missing');
        expecting(429, 'rate_limited');
        expecting(500, 'upstream_error');
        expecting(502, 'upstream_error');
        const errorRate = classify('openai', 429, 'rate limit exceeded for reasoning.effort');
        expect(errorRate.effortRejection === false, 'a 429 is never an effort rejection');
        const errorMissing = classify('gemini', 404, 'model gemini-9 does not exist; thinking level is unsupported');
        expect(errorMissing.effortRejection === false, 'a 404 is never an effort rejection');
    }));

    results.push(await runCase('classifier: each platform’s effort fingerprint is rejected_effort', () => {
        const cases: Array<[ProbePlatform, number, string, string]> = [
            ['gemini', 400, 'Thinking level is unsupported: THINKING_LEVEL_MINIMAL', 'rejected_effort'],
            ['gemini', 400, 'Thinking budget is not supported for this model', 'rejected_effort'],
            ['openai', 400, "Unsupported parameter: 'reasoning.effort'", 'rejected_effort'],
            ['openai', 400, "Invalid value for 'reasoning.effort': must be one of none, low, …", 'rejected_effort'],
            ['anthropic', 400, "output_config.effort: Input should be 'low', 'medium', 'high', 'xhigh' or 'max'", 'rejected_effort'],
            ['anthropic', 400, 'thinking.type: Extra inputs are not permitted', 'rejected_effort'],
            ['grok', 400, 'Argument not supported: reasoning.effort', 'rejected_effort'],
            ['deepseek', 400, 'Unrecognized request argument supplied: reasoning_effort', 'rejected_effort'],
            ['mimo', 400, "Invalid value for 'thinking.type'", 'rejected_effort'],
        ];
        for (const [platform, status, raw, expected] of cases) {
            const result = classify(platform, status, raw);
            expect(result.errorClass === expected, `${platform}: ${raw.slice(0, 40)} → ${expected} (got ${result.errorClass})`);
            expect(result.effortRejection === true, `${platform}: flagged as an effort rejection`);
            expect(result.retryable === false, `${platform}: a 400 is never retried`);
        }
    }));

    results.push(await runCase('classifier: unrelated 400s are rejected_other or unclassified, never effort', () => {
        const other = classify('openai', 400, 'tools: function schema is invalid');
        expect(other.errorClass === 'rejected_other', `tools error → rejected_other (got ${other.errorClass})`);
        const gray = classify('grok', 400, 'bad request');
        expect(gray.errorClass === 'unclassified', `gray 400 → unclassified (got ${gray.errorClass})`);
        const reasoningMention = classify('deepseek', 400, 'reasoning_content is required in the assistant message');
        expect(reasoningMention.errorClass !== 'rejected_effort', 'merely mentioning reasoning is not a rejection');
        const filter = classify('mimo', 400, 'the request was blocked by the content filter');
        expect(filter.errorClass !== 'rejected_effort', 'content filtering is not an effort rejection');
        // The probe adds its own output caps. A lane that complains about the
        // cap (not about the level) must never shrink the accepted effort set.
        const anthropicCap = classify('anthropic', 400, 'max_tokens must be greater than the thinking budget');
        expect(anthropicCap.errorClass !== 'rejected_effort', `a max_tokens error is not an effort rejection (got ${anthropicCap.errorClass})`);
        const geminiCap = classify('gemini', 400, 'maxOutputTokens is too small for the requested thinking level');
        expect(geminiCap.errorClass !== 'rejected_effort', `a maxOutputTokens error is not an effort rejection (got ${geminiCap.errorClass})`);
    }));

    results.push(await runCase('classifier: model-missing / lane errors are not effort rejections', () => {
        const missing = classify('openai', 400, 'Model is unavailable: no available channel');
        expect(missing.errorClass === 'model_missing', `model_missing (got ${missing.errorClass})`);
        expect(missing.stopsModel === true, 'the model is skipped for the rest of the run');
        const lane = classify('gemini', null, 'overloaded: service unavailable', { thrownMessage: 'Error: 503' });
        expect(lane.errorClass === 'upstream_error' || lane.errorClass === 'network_error', `lane-level failure (got ${lane.errorClass})`);
    }));

    results.push(await runCase('classifier: retryable classes and stop flags', () => {
        const rate = classify('openai', 429, 'too many requests');
        expect(rate.retryable && !rate.stopsRun, '429 retryable, does not stop the run');
        const auth = classify('openai', 401, 'unauthorized');
        expect(auth.stopsRun === true && auth.retryable === false, 'auth stops the whole run');
        const upstream = classify('openai', 503, 'service unavailable');
        expect(upstream.retryable === true, '5xx retryable');
        const stream = classify('openai', 200, '', { thrownMessage: 'stream ended unexpectedly', duringStream: true });
        expect(stream.errorClass === 'stream_error', `mid-stream failure → stream_error (got ${stream.errorClass})`);
    }));

    results.push(await runCase('fingerprint normalizes ids and numbers; redaction removes secrets', () => {
        const first = fingerprintOf('Invalid value for reasoning.effort (request id abcdef12-3456-7890-abcd-ef1234567890): code 12345');
        const second = fingerprintOf('invalid value for reasoning.effort (request id 11111111-2222-3333-4444-555555555555): code 999');
        expect(first === second, `same shape → same fingerprint (${first} vs ${second})`);
        expect(!first.includes('12345'), 'numbers are normalized away');
        const redacted = redactSecrets('key sk-abcdefghijklmnop and Bearer abcdefghijk and https://x/?key=sk-live-12345678');
        expect(!redacted.includes('sk-abcdefghijklmnop'), 'sk- keys removed');
        expect(!redacted.includes('abcdefghijk'), 'bearer tokens removed');
        expect(!redacted.includes('sk-live-12345678'), 'query key values removed');
        const custom = createRedactor(['my-very-secret-value']);
        expect(custom('the relay echoed my-very-secret-value') === 'the relay echoed <redacted>', 'known secret values removed verbatim');
    }));
};

// ---------------------------------------------------------------------------
// 5. Result document, inference and schema validation
// ---------------------------------------------------------------------------

const runResultCases = async (): Promise<void> => {
    results.push(await runCase('summary: accepted efforts exclude mapped and sentinel values', () => {
        const spec = PROBE_MODEL_SNAPSHOT.find((model) => model.model === 'deepseek-flash');
        expect(spec !== undefined, 'deepseek in snapshot');
        if (spec === undefined) return;
        const observations: ProbeObservation[] = [
            observationFixture(candidateOf('deepseek', 'deepseek-flash', 'baseline', null)),
            observationFixture(candidateOf('deepseek', 'deepseek-flash', 'level', 'low')),
            observationFixture(candidateOf('deepseek', 'deepseek-flash', 'level', 'high')),
            observationFixture(candidateOf('deepseek', 'deepseek-flash', 'level', 'max')),
            observationFixture(candidateOf('deepseek', 'deepseek-flash', 'level', 'minimal')),
            observationFixture(candidateOf('deepseek', 'deepseek-flash', 'level', 'xhigh')),
            observationFixture(candidateOf('deepseek', 'deepseek-flash', 'toggle-off', null)),
        ];
        const summary = buildRunSummary({ probedAt: '2026-11-13T10:00:00.000Z', laneSignature: 'lane', specs: [spec], observations });
        expect(summary.document.results.length === 1, 'one importable model');
        const entry = summary.document.results[0];
        expect(entry !== undefined, 'entry exists');
        if (entry === undefined) return;
        expect(JSON.stringify(entry.acceptedEfforts) === JSON.stringify(['low', 'high', 'max']), `vendor-only accepted set (got ${entry.acceptedEfforts.join(',')})`);
        expect(entry.toggle === true, 'DeepSeek toggle detected from the accepted toggle-off');
        expect(entry.defaultEffort === spec.vendorDefaultEffort, 'W1-only run reports the vendor default');
        expect(Object.keys(entry.errorSummary).length === 0, 'mapped values are not errors');
        const inference = summary.inferences[0];
        expect(JSON.stringify(inference?.mappedEfforts) === JSON.stringify(['minimal', 'xhigh']), 'mapped efforts are recorded separately');
    }));

    results.push(await runCase('summary: incomplete models are left out of results.json', () => {
        const spec = PROBE_MODEL_SNAPSHOT.find((model) => model.model === 'gemini-4-hydrogen');
        expect(spec !== undefined, 'hydrogen in snapshot');
        if (spec === undefined) return;
        const observations: ProbeObservation[] = [
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'baseline', null), { outcome: 'error', errorClass: 'rate_limited' }),
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'low')),
        ];
        const summary = buildRunSummary({ probedAt: '2026-11-13T10:00:00.000Z', laneSignature: 'lane', specs: [spec], observations });
        expect(summary.document.results.length === 0, 'nothing importable');
        expect(summary.incomplete.length === 1, 'the model is reported as incomplete');
        expect(summary.incomplete[0]?.incompleteReasons.some((reason) => reason.includes('rate_limited')), 'the unreliable candidate is named');
    }));

    results.push(await runCase('summary: a rejected client-tool fidelity variant does not hide the plain matrix', () => {
        const spec = PROBE_MODEL_SNAPSHOT.find((model) => model.model === 'gemini-4-hydrogen');
        expect(spec !== undefined, 'hydrogen in snapshot');
        if (spec === undefined) return;
        const observations: ProbeObservation[] = [
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'baseline', null)),
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'low')),
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'high')),
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'xhigh')),
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'xhigh', { withClientTools: true }), {
                outcome: 'rejected',
                errorClass: 'rejected_other',
                errorSummary: '400 tools: function declarations unsupported',
            }),
        ];
        const summary = buildRunSummary({ probedAt: '2026-11-13T10:00:00.000Z', laneSignature: 'lane', specs: [spec], observations });
        expect(summary.document.results.length === 1, `hydrogen stays importable (incomplete: ${summary.incomplete.length})`);
        expect(JSON.stringify(summary.document.results[0]?.acceptedEfforts) === JSON.stringify(['low', 'high', 'xhigh']), 'the plain acceptance set is unaffected');
    }));

    results.push(await runCase('summary: rejected sentinels fill errorSummary but do not break completeness', () => {
        const spec = PROBE_MODEL_SNAPSHOT.find((model) => model.model === 'gemini-4-argon');
        expect(spec !== undefined, 'argon in snapshot');
        if (spec === undefined) return;
        const rejected = (effort: EffortValue): ProbeObservation =>
            observationFixture(candidateOf('gemini', 'gemini-4-argon', 'level', effort), {
                outcome: 'rejected',
                errorClass: 'rejected_effort',
                errorSummary: `400 Thinking level is unsupported: THINKING_LEVEL_${effort.toUpperCase()}`,
            });
        const observations: ProbeObservation[] = [
            observationFixture(candidateOf('gemini', 'gemini-4-argon', 'baseline', null)),
            observationFixture(candidateOf('gemini', 'gemini-4-argon', 'level', 'low')),
            observationFixture(candidateOf('gemini', 'gemini-4-argon', 'level', 'medium')),
            observationFixture(candidateOf('gemini', 'gemini-4-argon', 'level', 'high')),
            rejected('xhigh'),
            rejected('minimal'),
        ];
        const summary = buildRunSummary({ probedAt: '2026-11-13T10:00:00.000Z', laneSignature: 'lane', specs: [spec], observations });
        expect(summary.document.results.length === 1, 'argon still importable');
        const entry = summary.document.results[0];
        expect(entry !== undefined && Object.keys(entry.errorSummary).length === 2, 'both sentinels have an error summary');
        expect(entry?.errorSummary['minimal'] !== undefined, 'the minimal fingerprint is kept');
    }));

    results.push(await runCase('inference: baseline closest to the vendor default level', () => {
        const spec = PROBE_MODEL_SNAPSHOT.find((model) => model.model === 'gemini-4-hydrogen');
        expect(spec !== undefined, 'hydrogen in snapshot');
        if (spec === undefined) return;
        const observations: ProbeObservation[] = [
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'baseline', null, { wave: 'w2', repeat: 1 }), { reasoningTokens: 1200 }),
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'baseline', null, { wave: 'w2', repeat: 2 }), { reasoningTokens: 1150 }),
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'baseline', null, { wave: 'w2', repeat: 3 }), { reasoningTokens: 1250 }),
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'high', { wave: 'w2', repeat: 1 }), { reasoningTokens: 1180 }),
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'high', { wave: 'w2', repeat: 2 }), { reasoningTokens: 1220 }),
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'xhigh', { wave: 'w2', repeat: 1 }), { reasoningTokens: 2600 }),
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'xhigh', { wave: 'w2', repeat: 2 }), { reasoningTokens: 2500 }),
        ];
        const inference = inferDefaultEffort(observations);
        expect(inference.defaultEffort === 'high', `infers high (got ${inference.defaultEffort ?? 'null'})`);
        expect(inference.confidence === 'high', `high confidence (got ${inference.confidence})`);
    }));

    results.push(await runCase('inference: no separation means null, never a guess', () => {
        const observations: ProbeObservation[] = [
            observationFixture(candidateOf('openai', 'gpt-6-luna', 'baseline', null, { wave: 'w2', repeat: 1 }), { reasoningTokens: 500 }),
            observationFixture(candidateOf('openai', 'gpt-6-luna', 'baseline', null, { wave: 'w2', repeat: 2 }), { reasoningTokens: 510 }),
            observationFixture(candidateOf('openai', 'gpt-6-luna', 'level', 'low', { wave: 'w2', repeat: 1 }), { reasoningTokens: 495 }),
            observationFixture(candidateOf('openai', 'gpt-6-luna', 'level', 'low', { wave: 'w2', repeat: 2 }), { reasoningTokens: 520 }),
            observationFixture(candidateOf('openai', 'gpt-6-luna', 'level', 'max', { wave: 'w2', repeat: 1 }), { reasoningTokens: 505 }),
            observationFixture(candidateOf('openai', 'gpt-6-luna', 'level', 'max', { wave: 'w2', repeat: 2 }), { reasoningTokens: 515 }),
        ];
        const inference = inferDefaultEffort(observations);
        expect(inference.defaultEffort === null, `no default when levels look identical (got ${inference.defaultEffort ?? 'null'})`);
        expect(inference.source === 'unknown', 'source is unknown');
    }));

    results.push(await runCase('inference: a truncated W2 sample never sets the default', () => {
        const observations: ProbeObservation[] = [
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'baseline', null, { wave: 'w2', repeat: 1 }), { reasoningTokens: 1180 }),
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'baseline', null, { wave: 'w2', repeat: 2 }), { reasoningTokens: 1220 }),
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'high', { wave: 'w2', repeat: 1 }), { reasoningTokens: 1200 }),
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'high', { wave: 'w2', repeat: 2 }), { reasoningTokens: 1210 }),
            // These look exactly like the baseline, but the probe cap cut them:
            // without exclusion the nearest level would be xhigh and no match.
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'xhigh', { wave: 'w2', repeat: 1 }), {
                reasoningTokens: 1200,
                finishReason: 'max_tokens',
            }),
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'xhigh', { wave: 'w2', repeat: 2 }), {
                reasoningTokens: 1210,
                finishReason: 'MAX_TOKENS',
            }),
        ];
        const inference = inferDefaultEffort(observations);
        expect(inference.truncatedSamples === 2, `two truncated samples counted (got ${inference.truncatedSamples})`);
        expect(inference.defaultEffort === 'high', `truncated samples do not win the match (got ${inference.defaultEffort ?? 'null'})`);
        expect(inference.confidence === 'high', `high confidence after exclusion (got ${inference.confidence})`);
        expect(inference.detail.includes('2 truncated'), `the detail names them (got ${inference.detail})`);
    }));

    results.push(await runCase('inert: a truncated level sample cannot prove "no effect"', () => {
        const spec = PROBE_MODEL_SNAPSHOT.find((model) => model.model === 'gpt-6-luna');
        expect(spec !== undefined, 'luna in snapshot');
        if (spec === undefined) return;
        const baseline = (repeat: number, thinking: number): ProbeObservation =>
            observationFixture(candidateOf('openai', 'gpt-6-luna', 'baseline', null, { wave: 'w2', repeat }), { reasoningTokens: thinking });
        const low = (repeat: number, thinking: number, finishReason: string): ProbeObservation =>
            observationFixture(candidateOf('openai', 'gpt-6-luna', 'level', 'low', { wave: 'w2', repeat }), {
                reasoningTokens: thinking,
                finishReason,
            });
        const observations: ProbeObservation[] = [baseline(1, 500), baseline(2, 510), low(1, 480, 'max_tokens'), low(2, 490, 'max_tokens')];
        expect(inertEffortsOf(spec, observations).length === 0, 'the capped level is not called inert');
        const closed: ProbeObservation[] = [baseline(1, 500), baseline(2, 510), low(1, 480, 'stop'), low(2, 490, 'stop')];
        expect(JSON.stringify(inertEffortsOf(spec, closed)) === JSON.stringify(['low']), 'the same numbers without a cap would be inert');
    }));

    results.push(await runCase('summary: truncated samples are counted in the notes and absent from results.json', () => {
        const spec = PROBE_MODEL_SNAPSHOT.find((model) => model.model === 'gemini-4-hydrogen');
        expect(spec !== undefined, 'hydrogen in snapshot');
        if (spec === undefined) return;
        const observations: ProbeObservation[] = [
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'baseline', null)),
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'high')),
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'xhigh')),
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'baseline', null, { wave: 'w2', repeat: 1 }), { reasoningTokens: 1200 }),
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'baseline', null, { wave: 'w2', repeat: 2 }), { reasoningTokens: 1210 }),
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'high', { wave: 'w2', repeat: 1 }), { reasoningTokens: 1190 }),
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'high', { wave: 'w2', repeat: 2 }), { reasoningTokens: 1200 }),
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'xhigh', { wave: 'w2', repeat: 1 }), {
                reasoningTokens: 4096,
                finishReason: 'max_tokens',
            }),
            observationFixture(candidateOf('gemini', 'gemini-4-hydrogen', 'level', 'xhigh', { wave: 'w2', repeat: 2 }), {
                reasoningTokens: 4096,
                finishReason: 'max_tokens',
            }),
        ];
        const summary = buildRunSummary({ probedAt: '2026-11-13T10:00:00.000Z', laneSignature: 'lane', specs: [spec], observations });
        expect(summary.inferences[0]?.truncatedSamples === 2, 'the model row counts two truncated samples');
        expect(summary.inferences[0]?.defaultInference.defaultEffort === 'high', 'the default still comes from the uncapped levels');
        const markdown = formatSummaryMarkdown({
            probedAt: '2026-11-13T10:00:00.000Z',
            laneSignature: 'lane',
            budgetUsd: 3,
            spentUsd: 1,
            summary,
            errors: [],
            startedAt: '2026-11-13T10:00:00.000Z',
            finishedAt: '2026-11-13T10:05:00.000Z',
        });
        expect(markdown.includes('truncated W2 samples: 2'), 'the summary header counts them');
        expect(markdown.includes('truncated samples ignored: 2'), 'the effect block names them');
        expect(markdown.includes('truncated: 2'), 'the model row names them');
        const entry = summary.document.results[0];
        expect(entry !== undefined && !Object.keys(entry).includes('truncated'), 'the §7 result entry keeps its exact keys');
    }));

    results.push(await runCase('schema: a built document passes validation; keys are exactly design §7', () => {
        const document = {
            schema: 1,
            probedAt: '2026-11-13T10:00:00.000Z',
            laneSignature: 'vertex-adc@global|ephone|ephone|official-xai|official-deepseek|official-mimo',
            results: [
                {
                    model: 'gemini-4-hydrogen',
                    acceptedEfforts: ['low', 'medium', 'high', 'xhigh'],
                    defaultEffort: 'high',
                    toggle: false,
                    errorSummary: { minimal: '400 Thinking level is unsupported' },
                    checkedOn: '2026-11-13',
                },
            ],
        };
        const validation = validatedDocumentCheck(document);
        expect(validation.valid, `valid (errors: ${validation.errors.join('; ')})`);
        const entry = validation.document?.results[0];
        expect(entry !== undefined, 'entry parsed');
        if (entry === undefined) return;
        expect(JSON.stringify(Object.keys(entry).sort()) === JSON.stringify(['acceptedEfforts', 'checkedOn', 'defaultEffort', 'errorSummary', 'model', 'toggle']), 'result keys are exactly the design fields');
        expect(document.schema === 1 && document.results.length === 1, 'document shape');
    }));

    results.push(await runCase('schema: bad documents are rejected with readable errors', () => {
        const cases: unknown[] = [
            { schema: 2, probedAt: 'x', laneSignature: '', results: [] },
            { schema: 1, probedAt: 'not-a-date', laneSignature: 'lane', results: [] },
            { schema: 1, probedAt: '2026-11-13T10:00:00.000Z', laneSignature: 'lane', results: [{ model: 'm', acceptedEfforts: ['bogus'], defaultEffort: null, toggle: false, errorSummary: {}, checkedOn: '2026-11-13' }] },
            { schema: 1, probedAt: '2026-11-13T10:00:00.000Z', laneSignature: 'lane', results: [{ model: 'm', acceptedEfforts: [], defaultEffort: 'nope', toggle: 'yes', errorSummary: {}, checkedOn: '13-11-2026' }] },
            'not-an-object',
        ];
        for (const value of cases) {
            const validation = validatedDocumentCheck(value);
            expect(!validation.valid, `rejected: ${JSON.stringify(value).slice(0, 60)}`);
            expect(validation.errors.length > 0, 'at least one error message');
        }
        const unknownKeys = validatedDocumentCheck({
            schema: 1,
            probedAt: '2026-11-13T10:00:00.000Z',
            laneSignature: 'lane',
            comment: 'owner annotation',
            results: [{ model: 'm', acceptedEfforts: ['low'], defaultEffort: null, toggle: false, errorSummary: {}, checkedOn: '2026-11-13', note: 'x' }],
        });
        expect(unknownKeys.valid, 'unknown keys are ignored, not rejected');
        expect(checkOnDate('2026-11-13'), 'checkedOn helper accepts a date');
        expect(!checkOnDate('2026-13-40'), 'checkedOn helper rejects an impossible date');
    }));

    results.push(await runCase('results document has a date-only checkedOn and sorted accepted efforts', () => {
        const spec = PROBE_MODEL_SNAPSHOT.find((model) => model.model === 'grok-4.7');
        expect(spec !== undefined, 'grok in snapshot');
        if (spec === undefined) return;
        const observations: ProbeObservation[] = [
            observationFixture(candidateOf('grok', 'grok-4.7', 'baseline', null)),
            observationFixture(candidateOf('grok', 'grok-4.7', 'level', 'xhigh')),
            observationFixture(candidateOf('grok', 'grok-4.7', 'level', 'low')),
            observationFixture(candidateOf('grok', 'grok-4.7', 'level', 'high')),
        ];
        const summary = buildRunSummary({ probedAt: '2026-11-13T23:59:59.000Z', laneSignature: 'lane', specs: [spec], observations });
        const entry = summary.document.results[0];
        expect(entry?.checkedOn === '2026-11-13', 'checkedOn is the probe date');
        expect(JSON.stringify(entry?.acceptedEfforts) === JSON.stringify(['low', 'high', 'xhigh']), 'ascending effort order');
        expect(summary.document.results.every((row) => row.checkedOn === '2026-11-13'), 'all rows share the date');
    }));
};

// ---------------------------------------------------------------------------
// 6. Runner: dry-run, stub pipeline, retries, breakers, auth
// ---------------------------------------------------------------------------

const runRunnerCases = async (): Promise<void> => {
    results.push(await runCase('dry-run: writes the plan and sends nothing', async () => {
        const lanes = createProbeLanes(testEnvironment(), { fetch: createStubFetch(), lanes: fixtureLaneConfigurations() });
        let sends = 0;
        const guarded: typeof lanes = {
            ...lanes,
            gemini: { ...lanes.gemini, send: async () => { sends += 1; throw new Error('dry-run must not send'); } },
        };
        const outDir = join(scratchDirectory(), 'run');
        const outcome = await runProbe({
            wave: 'all',
            budget: defaultBudget('all'),
            dryRun: true,
            stub: false,
            lanes: guarded,
            environment: testEnvironment(),
            outDir,
            gates: [],
            pacingMs: null,
            log: () => {},
        });
        expect(sends === 0, `no lane was called (got ${sends})`);
        expect(outcome.requestCount === 0 && outcome.spentUsd === 0, 'zero requests, zero cost');
        expect(existsSync(join(outDir, 'plan.json')), 'plan.json written');
        expect(existsSync(join(outDir, 'run.json')), 'run.json written');
        expect(!existsSync(join(outDir, 'results.json')), 'dry-run writes no importable result');
        const plan: { mode: string; requests: number } = JSON.parse(readFileSync(join(outDir, 'plan.json'), 'utf8'));
        expect(plan.mode === 'dry-run' && plan.requests === 149, `plan says dry-run with 149 requests (got ${plan.mode}/${plan.requests})`);
    }));

    results.push(await runCase('stub pipeline: 149 requests, valid results.json for 13 models', async () => {
        const outDir = join(scratchDirectory(), 'stub');
        const environment = testEnvironment();
        const lanes = createProbeLanes(environment, { fetch: createStubFetch(), lanes: stubLaneConfigurations() });
        const outcome = await runProbe({
            wave: 'all',
            budget: defaultBudget('all'),
            dryRun: false,
            stub: true,
            lanes,
            environment,
            outDir,
            gates: [],
            pacingMs: null,
            log: () => {},
        });
        expect(outcome.requestCount === 149, `149 requests (got ${outcome.requestCount})`);
        expect(outcome.spentUsd <= outcome.plan.estimatedUsd, 'actual spend stays under the worst-case estimate');
        expect(outcome.document !== null && outcome.document.results.length === 13, `13 importable models (got ${outcome.document?.results.length ?? 0})`);
        const validation = validatedDocumentCheck(JSON.parse(readFileSync(join(outDir, 'results.json'), 'utf8')));
        expect(validation.valid, `written results.json validates (errors: ${validation.errors.join('; ')})`);
        expect(existsSync(join(outDir, 'observations.json')) && existsSync(join(outDir, 'summary.md')) && existsSync(join(outDir, 'run.json')), 'all artifacts written');
        const run: { mode: string; requests: number } = JSON.parse(readFileSync(join(outDir, 'run.json'), 'utf8'));
        expect(run.mode === 'stub' && run.requests === 149, 'run.json records the stub mode and request count');
        const byModel = new Map(outcome.document?.results.map((entry) => [entry.model, entry]) ?? []);
        expect(JSON.stringify(byModel.get('gemini-4-hydrogen')?.acceptedEfforts) === JSON.stringify(['low', 'medium', 'high', 'xhigh']), 'hydrogen accepted set');
        expect(byModel.get('gemini-4-argon')?.defaultEffort === 'medium', 'argon default inferred as medium');
        expect(byModel.get('gpt-6-luna')?.defaultEffort === 'medium', 'luna default inferred as medium');
        expect(byModel.get('deepseek-flash')?.toggle === true, 'deepseek toggle detected');
        expect(byModel.get('mimo-v2.6-flash')?.toggle === true && byModel.get('mimo-v2.6-flash')?.acceptedEfforts.length === 0, 'mimo is toggle-only');
        expect(outcome.summary !== null && outcome.summary.incomplete.length === 0, 'no incomplete model in the stub run');
    }));

    results.push(await runCase('stub pipeline: secrets never reach the artifacts', async () => {
        const outDir = join(scratchDirectory(), 'stub-redaction');
        const environment = testEnvironment();
        const lanes = createProbeLanes(environment, { fetch: createStubFetch(), lanes: fixtureLaneConfigurations() });
        await runProbe({
            wave: 'w1',
            budget: defaultBudget('w1'),
            dryRun: false,
            stub: true,
            lanes,
            environment,
            outDir,
            gates: [],
            pacingMs: null,
            log: () => {},
        });
        const files = ['plan.json', 'results.json', 'observations.json', 'summary.md', 'run.json'];
        const secrets = environment.secrets;
        for (const name of files) {
            const text = readFileSync(join(outDir, name), 'utf8');
            for (const secret of secrets) expect(!text.includes(secret), `${name} must not contain a credential`);
        }
    }));

    results.push(await runCase('w2-only run composes the existing accepted set with new default inference', async () => {
        const outDir = join(scratchDirectory(), 'w2-only');
        const environment = testEnvironment();
        const lanes = createProbeLanes(environment, { fetch: createStubFetch(), lanes: stubLaneConfigurations() });
        const outcome = await runProbe({
            wave: 'w2',
            budget: defaultBudget('w2'),
            models: ['gemini-4-hydrogen'],
            acceptedEffortsByModel: { 'gemini-4-hydrogen': ['low', 'medium', 'high', 'xhigh'] },
            dryRun: false,
            stub: true,
            lanes,
            environment,
            outDir,
            gates: [],
            pacingMs: null,
            log: () => {},
        });
        expect(outcome.requestCount === 7, `7 W2 requests (got ${outcome.requestCount})`);
        expect(outcome.document?.results.length === 1, 'one composed model row');
        const entry = outcome.document?.results[0];
        expect(JSON.stringify(entry?.acceptedEfforts) === JSON.stringify(['low', 'medium', 'high', 'xhigh']), 'accepted set comes from the previous results');
        expect(entry?.defaultEffort === 'high', `default inferred from the new samples (got ${entry?.defaultEffort ?? 'null'})`);
    }));

    results.push(await runCase('runner: the budget W2 cap reaches the wire and run.json', async () => {
        const environment = testEnvironment();
        const baseLanes = createProbeLanes(environment, { fetch: createStubFetch(), lanes: stubLaneConfigurations() });
        const sentCaps: number[] = [];
        const capturing: typeof baseLanes = {
            ...baseLanes,
            deepseek: {
                ...baseLanes.deepseek,
                send: async (candidate, sendOptions) => {
                    sentCaps.push(sendOptions.maxOutputTokens);
                    return createObservationFixture(candidate, { reasoningTokens: 100, outcome: 'accepted' });
                },
            },
        };
        const runWith = async (budget: { readonly w2OutputTokenCap?: number }, name: string) => {
            const outDir = join(scratchDirectory(), name);
            const outcome = await runProbe({
                wave: 'w2',
                budget: { ...defaultBudget('w2'), ...(budget.w2OutputTokenCap === undefined ? {} : { w2OutputTokenCap: budget.w2OutputTokenCap }) },
                models: ['deepseek-flash'],
                acceptedEffortsByModel: { 'deepseek-flash': ['low', 'high', 'max'] },
                dryRun: false,
                stub: true,
                lanes: capturing,
                environment,
                outDir,
                gates: [],
                pacingMs: null,
                retryDelayMs: 0,
                log: () => {},
            });
            return { outDir, outcome };
        };
        const raised = await runWith({ w2OutputTokenCap: 8_192 }, 'w2-cap-raised');
        expect(sentCaps.length === 7, `7 W2 requests (got ${sentCaps.length})`);
        expect(sentCaps.every((cap) => cap === 8_192), `the raised cap is sent (got ${sentCaps.join(',')})`);
        expect(raised.outcome.plan.perWave.w2.estimatedUsd === 0.069443, `the plan prices the raised cap (${raised.outcome.plan.perWave.w2.estimatedUsd})`);
        const raisedRun: { budget: { w2OutputTokenCap?: number } } = JSON.parse(readFileSync(join(raised.outDir, 'run.json'), 'utf8'));
        expect(raisedRun.budget.w2OutputTokenCap === 8_192, 'run.json records the effective cap');
        sentCaps.length = 0;
        const plain = await runWith({}, 'w2-cap-default');
        expect(plain.outcome.requestCount === 7 && sentCaps.every((cap) => cap === 4_096), `the default cap is 4096 (got ${sentCaps.join(',')})`);
    }));

    results.push(await runCase('runner retries a 429 once, then keeps the success', async () => {
        const outDir = join(scratchDirectory(), 'retry');
        const environment = testEnvironment();
        const stubLanes = createProbeLanes(environment, { fetch: createStubFetch(), lanes: stubLaneConfigurations() });
        let calls = 0;
        const flaky: typeof stubLanes = {
            ...stubLanes,
            deepseek: {
                ...stubLanes.deepseek,
                send: async (candidate) => {
                    calls += 1;
                    const observation = createObservationFixture(candidate, {
                        outcome: calls === 1 ? 'error' : 'accepted',
                        errorClass: calls === 1 ? 'rate_limited' : null,
                        reasoningTokens: 100,
                    });
                    return observation;
                },
            },
        };
        const outcome = await runProbe({
            wave: 'w1',
            budget: { maxRequests: 2, maxUsd: 3, timeoutMs: 5_000, maxRetries: 1 },
            models: ['deepseek-flash'],
            dryRun: false,
            stub: true,
            lanes: flaky,
            environment,
            outDir,
            gates: [],
            pacingMs: null,
            retryDelayMs: 0,
            log: () => {},
        });
        expect(calls === 2, `two attempts (got ${calls})`);
        expect(outcome.requestCount === 2 && outcome.retryCount === 1, 'one retry recorded');
        expect(outcome.observations[1]?.outcome === 'accepted', 'the retried request succeeded');
        expect(outcome.observations[0]?.attempt === 1 && outcome.observations[1]?.attempt === 2, 'attempt numbers are sequential');
    }));

    results.push(await runCase('runner stops a lane after three consecutive 429s', async () => {
        const outDir = join(scratchDirectory(), 'breaker');
        const environment = testEnvironment();
        const stubLanes = createProbeLanes(environment, { fetch: createStubFetch(), lanes: stubLaneConfigurations() });
        let calls = 0;
        const limited: typeof stubLanes = {
            ...stubLanes,
            deepseek: {
                ...stubLanes.deepseek,
                send: async (candidate) => {
                    calls += 1;
                    return createObservationFixture(candidate, { outcome: 'error', errorClass: 'rate_limited' });
                },
            },
        };
        const outcome = await runProbe({
            wave: 'w1',
            budget: defaultBudget('w1'),
            models: ['deepseek-flash'],
            dryRun: false,
            stub: true,
            lanes: limited,
            environment,
            outDir,
            gates: [],
            pacingMs: null,
            retryDelayMs: 0,
            log: () => {},
        });
        expect(calls === 3, `the lane is called 3 times (got ${calls})`);
        expect(outcome.skipped.length === 7, `the remaining 7 candidates are skipped (got ${outcome.skipped.length})`);
        expect(outcome.skipped.every((entry) => entry.reason.includes('circuit breaker')), 'skips name the circuit breaker');
    }));

    results.push(await runCase('runner stops the whole run on an auth error', async () => {
        const outDir = join(scratchDirectory(), 'auth');
        const environment = testEnvironment();
        const stubLanes = createProbeLanes(environment, { fetch: createStubFetch(), lanes: stubLaneConfigurations() });
        const denied: typeof stubLanes = {
            ...stubLanes,
            deepseek: {
                ...stubLanes.deepseek,
                send: async (candidate) => createObservationFixture(candidate, { outcome: 'error', errorClass: 'auth_error' }),
            },
        };
        const outcome = await runProbe({
            wave: 'w1',
            budget: defaultBudget('w1'),
            models: ['deepseek-flash'],
            dryRun: false,
            stub: true,
            lanes: denied,
            environment,
            outDir,
            gates: [],
            pacingMs: null,
            retryDelayMs: 0,
            log: () => {},
        });
        expect(outcome.requestCount === 1, `stops after the first request (got ${outcome.requestCount})`);
        expect(outcome.stoppedReason?.includes('auth_error') === true, `stop reason names auth (got ${outcome.stoppedReason ?? 'null'})`);
        expect(outcome.document?.results.length === 0, 'nothing importable from an auth failure');
    }));

    results.push(await runCase('runner skips a lane that is not configured instead of throwing', async () => {
        const outDir = join(scratchDirectory(), 'unconfigured');
        const environment = testEnvironment();
        const stubLanes = createProbeLanes(environment, { fetch: createStubFetch(), lanes: stubLaneConfigurations() });
        const unready: typeof stubLanes = {
            ...stubLanes,
            grok: { ...stubLanes.grok, ready: false, configuration: { ...stubLanes.grok.configuration, problems: ['GROK_API_KEY is not set'] } },
        };
        const outcome = await runProbe({
            wave: 'w1',
            budget: defaultBudget('w1'),
            models: ['grok-4.7'],
            dryRun: false,
            stub: true,
            lanes: unready,
            environment,
            outDir,
            gates: [],
            pacingMs: null,
            log: () => {},
        });
        expect(outcome.requestCount === 0, 'no request to an unconfigured lane');
        expect(outcome.skipped.length === 7, `all candidates are skipped (got ${outcome.skipped.length})`);
        expect(outcome.skipped.every((entry) => entry.reason.includes('lane not configured')), 'the skip reason names the lane');
    }));
};

// ---------------------------------------------------------------------------
// 7. Environment: .env.test only, lane signature, gates
// ---------------------------------------------------------------------------

const runEnvironmentCases = async (): Promise<void> => {
    results.push(await runCase('.env.test is read, .env is never read, process env wins', () => {
        const repositoryRoot = scratchDirectory();
        writeFileSync(
            join(repositoryRoot, '.env.test'),
            ['TEST_INSTANCE=1', 'DB_PATH=database.test.sqlite', 'OPENAI_API_URL=https://api.ephone.ai/v1', 'OPENAI_API_KEY=from-env-test-key', ''].join('\n')
        );
        writeFileSync(join(repositoryRoot, '.env'), 'OPENAI_API_KEY=from-production-env-file\nSECRET_FROM_DOT_ENV=evil\n');
        const environment = loadProbeEnvironment({ processEnvironment: {}, repositoryRoot });
        expect(environment.values['OPENAI_API_KEY'] === 'from-env-test-key', 'the value comes from .env.test');
        expect(environment.values['SECRET_FROM_DOT_ENV'] === undefined, '.env is never read');
        expect(environment.usedEnvFile === true && environment.filledKeys >= 4, 'the file was used');
        expect(!environment.warnings.some((warning) => warning.includes('dot-env')), 'no warning about .env');
        expect(environment.values['OPENAI_API_KEY'] !== 'from-production-env-file', 'the production file never leaks in');
        const overridden = loadProbeEnvironment({ processEnvironment: { OPENAI_API_KEY: 'from-process-key' }, repositoryRoot });
        expect(overridden.values['OPENAI_API_KEY'] === 'from-process-key', 'an injected process value wins over the file');
        const missing = loadProbeEnvironment({ processEnvironment: {}, repositoryRoot: scratchDirectory() });
        expect(missing.usedEnvFile === false && missing.warnings.length === 1, 'a missing .env.test is reported, not fatal');
    }));

    results.push(await runCase('run gates: only the test instance with the test database may spend', () => {
        const ok = evaluateRunGates(testEnvironment());
        expect(ok.ok, 'test env passes');
        const absolute = evaluateRunGates(testEnvironment({ DB_PATH: '/app/k-on-bot/database.test.sqlite' }));
        expect(absolute.ok, 'an absolute DB_PATH still passes');
        const production = evaluateRunGates(testEnvironment({ DB_PATH: 'database.sqlite' }));
        expect(!production.ok && production.reasons.some((reason) => reason.includes('DB_PATH')), 'the production DB is refused');
        const notTest = evaluateRunGates(testEnvironment({ TEST_INSTANCE: '0' }));
        expect(!notTest.ok && notTest.reasons.some((reason) => reason.includes('TEST_INSTANCE')), 'a non-test instance is refused');
        const absent = evaluateRunGates(testEnvironment({ DB_PATH: '' }));
        expect(!absent.ok, 'an unset DB_PATH is refused');
    }));

    results.push(await runCase('lane signature: changes when the traffic path changes', () => {
        const first = laneSignatureOf(laneConfigurationsOf(testEnvironment(), { credentialsFileExists: () => true }));
        expect(first.includes('ephone'), `the ephone lane is named (got ${first})`);
        expect(first.includes('official-xai') && first.includes('official-deepseek') && first.includes('official-mimo'), 'official lanes are named');
        const changed = laneSignatureOf(
            laneConfigurationsOf(testEnvironment({ OPENAI_API_URL: 'https://api.openai.com/v1' }), { credentialsFileExists: () => true })
        );
        expect(changed !== first, 'changing the base URL changes the signature');
        const relay = laneSignatureOf(laneConfigurationsOf(testEnvironment({ GEMINI_API_URL: 'https://relay.example/v1' }), { credentialsFileExists: () => true }));
        expect(relay.includes('gemini-relay:relay.example'), `a Gemini relay is named with its host (got ${relay})`);
        const adc = laneSignatureOf(laneConfigurationsOf(testEnvironment({ GOOGLE_CLOUD_PROJECT: 'proj', GOOGLE_APPLICATION_CREDENTIALS: '/tmp/sa.json' }), { credentialsFileExists: (path) => path === '/tmp/sa.json' }));
        expect(adc.startsWith('vertex-adc@global'), `ADC is detected when the credentials file exists (got ${adc})`);
        const deepseekFallback = laneConfigurationsOf(testEnvironment({ DEEPSEEK_API_KEY: '' }), { credentialsFileExists: () => true });
        expect(deepseekFallback.deepseek.laneId.includes('openai-fallback'), 'a missing DeepSeek key falls back to the OpenAI lane like production');
    }));

    results.push(await runCase('lane fingerprint: a changed key or project invalidates data without printing it', () => {
        const fingerprintOfLane = (laneId: string): string | null => {
            const match = /#([kp])([0-9a-f]{8})$/.exec(laneId);
            return match === null ? null : `${match[1] ?? ''}${match[2] ?? ''}`;
        };
        const openaiLane = laneConfigurationsOf(testEnvironment(), { credentialsFileExists: () => true }).openai;
        expect(/#k[0-9a-f]{8}$/.test(openaiLane.laneId), `a relay lane carries the key hash (got ${openaiLane.laneId})`);
        expect(fingerprintOfLane(openaiLane.laneId) !== null, 'the hash is parseable');
        expect(!openaiLane.laneId.includes('offline-openai-key'), 'the key itself never reaches the lane id');
        const project = 'probe-test-project-1234';
        const adc = laneConfigurationsOf(testEnvironment({ GOOGLE_CLOUD_PROJECT: project, GOOGLE_APPLICATION_CREDENTIALS: '/tmp/sa.json' }), {
            credentialsFileExists: (path) => path === '/tmp/sa.json',
        }).gemini;
        expect(/#p[0-9a-f]{8}$/.test(adc.laneId), `the ADC lane carries the project hash (got ${adc.laneId})`);
        expect(!adc.laneId.includes(project), 'the project name itself never reaches the lane id');
        const sameSignature = laneSignatureOf(
            laneConfigurationsOf(testEnvironment({ GOOGLE_CLOUD_PROJECT: project, GOOGLE_APPLICATION_CREDENTIALS: '/tmp/sa.json' }), {
                credentialsFileExists: () => true,
            })
        );
        const otherProject = laneSignatureOf(
            laneConfigurationsOf(testEnvironment({ GOOGLE_CLOUD_PROJECT: 'probe-test-project-9999', GOOGLE_APPLICATION_CREDENTIALS: '/tmp/sa.json' }), {
                credentialsFileExists: () => true,
            })
        );
        expect(otherProject !== sameSignature, 'another project changes the signature');
        const sameKey = laneSignatureOf(laneConfigurationsOf(testEnvironment(), { credentialsFileExists: () => true }));
        const otherKey = laneSignatureOf(
            laneConfigurationsOf(testEnvironment({ OPENAI_API_KEY: 'another-offline-openai-key', ANTHROPIC_API_KEY: 'another-offline-anthropic-key' }), {
                credentialsFileExists: () => true,
            })
        );
        expect(otherKey !== sameKey, 'another key changes the signature');
        const express = laneConfigurationsOf(testEnvironment({ GEMINI_API_URL: '' }), { credentialsFileExists: () => false }).gemini;
        expect(/#k[0-9a-f]{8}$/.test(express.laneId), `the Vertex express lane carries the key hash (got ${express.laneId})`);
        expect(!express.laneId.includes('offline-gemini-key'), 'the express key is hashed, not printed');
    }));

    results.push(await runCase('lane fallbacks: DeepSeek and Grok mirror the production constructors', () => {
        const lanesIn = (values: Readonly<Record<string, string>>) =>
            laneConfigurationsOf(testEnvironment(values), { credentialsFileExists: () => true });
        // A missing DeepSeek URL alone never falls back to the OpenAI URL.
        const deepseekNoUrl = lanesIn({ DEEPSEEK_API_URL: '' }).deepseek;
        expect(deepseekNoUrl.baseUrl === 'https://api.deepseek.com/v1', `the official DeepSeek default is used (got ${String(deepseekNoUrl.baseUrl)})`);
        expect(deepseekNoUrl.apiKey === 'offline-deepseek-key', 'the DeepSeek key is kept');
        expect(deepseekNoUrl.problems.length === 0, 'a defaulted URL is not a problem');
        // A missing DeepSeek key falls back to the OpenAI client, exactly as production.
        const fallback = lanesIn({ DEEPSEEK_API_KEY: '' }).deepseek;
        expect(fallback.baseUrl === 'https://api.ephone.ai/v1', `the OpenAI URL is reused (got ${String(fallback.baseUrl)})`);
        expect(fallback.apiKey === 'offline-openai-key', 'the OpenAI key is reused');
        expect(fallback.laneId.includes('openai-fallback'), 'the fallback is visible in the lane id');
        expect(fallback.problems.length === 0, 'a working fallback client is ready');
        const noFallback = lanesIn({ DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '' }).deepseek;
        expect(noFallback.apiKey === null && noFallback.problems.length > 0, 'no OpenAI key means the fallback cannot be built');
        // Grok keeps the OpenAI SDK's default base URL when its own is unset.
        const grokNoUrl = lanesIn({ GROK_API_URL: '' }).grok;
        expect(grokNoUrl.baseUrl === 'https://api.openai.com/v1', `the SDK default base URL is used (got ${String(grokNoUrl.baseUrl)})`);
        expect(grokNoUrl.problems.length > 0, 'the missing GROK_API_URL keeps the lane from spending');
        const grok = lanesIn({}).grok;
        expect(grok.baseUrl === 'https://api.x.ai/v1' && grok.problems.length === 0, 'a configured Grok lane is ready');
    }));

    results.push(await runCase('lane reports never print a credential', () => {
        const environment = testEnvironment({ GEMINI_API_KEY: '' });
        const lanes = laneConfigurationsOf(environment, { credentialsFileExists: () => false });
        // The apiKey field exists for the clients; the report is laneId/host/problems
        const publicText = JSON.stringify(
            Object.values(lanes).map((lane) => ({ laneId: lane.laneId, host: lane.host, baseUrl: lane.baseUrl, problems: lane.problems }))
        );
        for (const secret of environment.secrets) expect(!publicText.includes(secret), 'lane report leaks no credential');
        expect(lanes.gemini.problems.length > 0, 'a Gemini lane without ADC/relay/key is not ready');
        expect(lanes.gemini.laneId === 'unconfigured', 'it is reported as unconfigured');
    }));
};

// ---------------------------------------------------------------------------
// 8. Accumulators directly (Gemini path uses extraBody, which the wire test cannot merge)
// ---------------------------------------------------------------------------

/** The accumulators read wire payloads; a JSON round-trip lets a test use a partial payload */
const geminiWire = (payload: Record<string, unknown>): GenerateContentResponse => JSON.parse(JSON.stringify(payload));
const responsesWire = (payload: Record<string, unknown>): ResponseStreamEvent => JSON.parse(JSON.stringify(payload));

const runAccumulatorCases = async (): Promise<void> => {
    results.push(await runCase('Gemini accumulator sums thoughts into billable output', () => {
        const state: StreamState = createStreamState();
        accumulateGemini(
            state,
            geminiWire({
                candidates: [{ content: { parts: [{ text: 'why', thought: true }] } }],
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 40, totalTokenCount: 53 },
            })
        );
        expect(state.reasoningTokens === 40 && state.outputTokens === 43, 'thoughts are added to billable output');
        expect(state.thinkingChars === 3 && state.inputTokens === 10, 'text and input tokens counted');
    }));

    results.push(await runCase('Responses accumulator keeps the incomplete reason of a capped answer', () => {
        const state: StreamState = createStreamState();
        accumulateResponses(
            state,
            responsesWire({
                type: 'response.incomplete',
                response: { incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 5, output_tokens: 300, total_tokens: 305 } },
            })
        );
        expect(state.finishReason === 'max_output_tokens', `the cap reason is kept (got ${String(state.finishReason)})`);
        expect(isTokenCapFinishReason(state.finishReason), 'the sample is recognised as capped');
        const filtered: StreamState = createStreamState();
        accumulateResponses(
            filtered,
            responsesWire({ type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' } } })
        );
        expect(!isTokenCapFinishReason(filtered.finishReason), 'a content filter is not a token cap');
    }));

    results.push(await runCase('Responses accumulator reads completed usage and stream errors', () => {
        const state: StreamState = createStreamState();
        accumulateResponses(
            state,
            responsesWire({
                type: 'response.completed',
                response: { usage: { input_tokens: 5, output_tokens: 9, total_tokens: 14, output_tokens_details: { reasoning_tokens: 4 } } },
            })
        );
        expect(state.reasoningTokens === 4 && state.outputTokens === 9 && state.totalTokens === 14, 'usage parsed');
        const failed: StreamState = createStreamState();
        accumulateResponses(failed, responsesWire({ type: 'error', message: 'boom' }));
        expect(failed.streamError === 'boom', 'error event captured');
    }));
};

// ---------------------------------------------------------------------------

results.push(await runCase('effort vocabulary: closed set, order and toggles', () => {
    expect(EFFORT_ORDER.length === 8, 'eight effort words');
    expect(isEffortValue('xhigh') && !isEffortValue('extreme'), 'closed set check');
    expect(JSON.stringify(sortEfforts(['high', 'low', 'medium'])) === JSON.stringify(['low', 'medium', 'high']), 'ascending sort');
}));

export const runAllProbeCases = async (): Promise<CaseResult[]> => {
    await runMatrixCases();
    await runWireBodyCases();
    await runLaneCases();
    await runClassificationCases();
    await runResultCases();
    await runRunnerCases();
    await runEnvironmentCases();
    await runAccumulatorCases();
    return results;
};

await runAllProbeCases();
reportResults(results);
