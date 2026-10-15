#!/usr/bin/env node
/**
 * Watch the OpenCode Go route that serves gemini-4-argon.
 *
 * Argon no longer comes from the hub or from Sub2API: it is only served by the
 * Go subscription's own Google-native route, and the bot reaches it directly
 * (`OPENCODE_GO_*` in .env maps `gemini-4-argon` to
 * `gemini-4-argon-contributor`). So the thing worth alerting on is whether that
 * route still answers end to end -- a lapsed subscription, an exhausted monthly
 * allowance, a withdrawn training consent or a changed protocol all break the
 * model, and all of them are invisible until somebody in the group asks Argon a
 * question.
 *
 * The old hub-listing layer is gone with it: Argon was never served by a hub
 * channel in practice (that path only ever answered "Model does not support this
 * protocol"), so it produced noise and a 24h-expiring admin token to babysit.
 *
 * Alerts fire on transitions only, so the SMS channel stays quiet:
 *   broken -> available, available -> broken, and broken -> a different failure.
 *
 *   node scripts/guard/argon-watch.mjs [--dry-run] [--force] [--json]
 *
 * Env: OPENCODE_GO_API_URL / OPENCODE_GO_API_KEY / OPENCODE_GO_MODEL_MAP (.env)
 *      ARGON_WATCH_MODEL=gemini-4-argon     model id to watch
 *      ARGON_WATCH_INTERVAL_MIN=15          throttle between runs
 *      ARGON_WATCH_PROBE_TIMEOUT_MS=60000   live probe timeout
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { envNumber, sendAlert } from './lib.mjs';

const flags = new Set(process.argv.slice(2));
const dryRun = flags.has('--dry-run');
const force = flags.has('--force');
const asJson = flags.has('--json');

const model = process.env.ARGON_WATCH_MODEL ?? 'gemini-4-argon';
const intervalMinutes = envNumber('ARGON_WATCH_INTERVAL_MIN', 15);
const probeTimeoutMs = envNumber('ARGON_WATCH_PROBE_TIMEOUT_MS', 60_000);
const stateFile = resolve(process.cwd(), process.env.ARGON_WATCH_STATE_FILE ?? 'tmp/argon-watch-state.json');

/** Mirrors src/ai/platforms/opencode-go-fetch.ts: request id -> upstream id */
const DEFAULT_MODEL_MAP = { 'gemini-4-argon': 'gemini-4-argon-contributor' };

const parseModelMap = () => {
    const map = { ...DEFAULT_MODEL_MAP };
    for (const pair of (process.env.OPENCODE_GO_MODEL_MAP ?? '').split(',')) {
        const [from, to] = pair.split('=').map((part) => part.trim());
        if (from && to) map[from] = to;
    }
    return map;
};

const readWatchState = () => {
    try {
        return JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch {
        return {};
    }
};

const writeWatchState = (watch) => {
    writeFileSync(stateFile, JSON.stringify({ argonWatch: watch }, null, 2));
};/**
 * The end-to-end question: does the Go subscription still serve the model the
 * way the bot asks for it? Streaming only -- that is what the bot does.
 */
const probeLive = async () => {
    const base = process.env.OPENCODE_GO_API_URL ?? 'https://opencode.ai';
    const key = process.env.OPENCODE_GO_API_KEY;
    if (!key) throw new Error('OPENCODE_GO_API_KEY is required (.env)');
    const upstreamModel = parseModelMap()[model] ?? model;
    const startedAt = Date.now();
    const response = await fetch(
        `${base}/inference/go/v1/models/${upstreamModel}:streamGenerateContent?alt=sse`,
        {
            method: 'POST',
            headers: {
                authorization: `Bearer ${key}`,
                'content-type': 'application/json',
                'x-opencode-session': 'k-on-bot:argon-watch',
                'user-agent': 'k-on-bot/1.0',
            },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: 'reply with exactly: ok' }] }],
                // Argon thinks before it answers and the thinking is billed against
                // this budget: 64 tokens ran out mid-thought and looked like an
                // empty reply, so leave room for both.
                generationConfig: { maxOutputTokens: 512 },
            }),
            signal: AbortSignal.timeout(probeTimeoutMs),
        }
    );
    const body = await response.text();
    const latencyMs = Date.now() - startedAt;
    const text = [...body.matchAll(/"text":\s*"((?:[^"\\]|\\.)*)"/g)]
        .map((match) => match[1])
        .join('');
    const errorMessage = body.match(/"message":\s*"((?:[^"\\]|\\.)*)"/)?.[1]?.slice(0, 200);

    const verdictOf = () => {
        if (response.status === 200 && text.trim().length > 0) return 'available';
        if (response.status === 200) return 'empty';
        if (/trains on request data|privacy settings/i.test(body)) return 'consent-required';
        if (/support this protocol/i.test(body)) return 'protocol-changed';
        if (/Model is unavailable/i.test(body)) return 'upstream-unavailable';
        if (response.status === 401 || response.status === 403) return 'auth';
        if (response.status === 429) return 'quota';
        return `http-${response.status}`;
    };

    return {
        verdict: verdictOf(),
        status: response.status,
        upstreamModel,
        latencyMs,
        errorMessage,
        text: text.slice(0, 80),
    };
};

/** Human-readable meaning for each verdict, so the SMS is actionable */
const explain = (probe) => {
    switch (probe.verdict) {
        case 'consent-required':
            return 'OpenCode 要求工作区打开 “Allow paid endpoints that train on request data”（contributor 档需要）。';
        case 'protocol-changed':
            return '上游不再接受这个协议/端点，需要重新核对 OpenCode Go 的 Argon 端点。';
        case 'upstream-unavailable':
            return '模型当前不可用（上游侧），稍后会自愈。';
        case 'auth':
            return 'API key 被拒，检查订阅是否还在或 key 是否被轮换。';
        case 'quota':
            return '额度/频率受限：Go 的 Argon 月额度可能已打满。';
        case 'empty':
            return '上游 200 但没出正文，可能是临时降级。';
        default:
            return `HTTP ${probe.status}${probe.errorMessage ? ` — ${probe.errorMessage}` : ''}`;
    }
};

const main = async () => {
    const watch = readWatchState().argonWatch ?? {};
    const elapsedMinutes = watch.lastRunAt ? (Date.now() - watch.lastRunAt) / 60_000 : Infinity;
    if (!force && elapsedMinutes < intervalMinutes) {
        if (!asJson) console.log(`skipped: last run ${elapsedMinutes.toFixed(1)} min ago (< ${intervalMinutes} min)`);
        return;
    }

    const probe = await probeLive();
    const previousProbe = watch.lastProbe ?? null;
    const alerts = [];
    if (probe.verdict === 'available' && previousProbe !== 'available') {
        alerts.push([
            '✅ gemini-4-argon 可用（OpenCode Go）',
            `模型 ${probe.upstreamModel}，延迟 ${probe.latencyMs}ms。`,
            probe.text ? `返回: ${probe.text}` : '',
        ].filter(Boolean).join('\n'));
    } else if (probe.verdict !== 'available' && previousProbe === 'available') {
        alerts.push([
            '⚠️ gemini-4-argon 不可用了（OpenCode Go）',
            `实测: ${probe.verdict} ${probe.latencyMs}ms`,
            explain(probe),
        ].join('\n'));
    } else if (probe.verdict !== 'available' && previousProbe !== null && previousProbe !== probe.verdict) {
        // Still broken, but for a different reason -- the fix usually differs.
        alerts.push([
            '⚠️ gemini-4-argon 仍不可用，原因变了',
            `之前: ${previousProbe} → 现在: ${probe.verdict}`,
            explain(probe),
        ].join('\n'));
    }

    if (!dryRun) {
        for (const message of alerts) await sendAlert('k-on-bot argon 监控', message);
    }

    // Rewrite the state wholesale: the previous version of this script stored
    // hub-listing fields that no longer mean anything.
    const nextWatch = {
        lastRunAt: Date.now(),
        lastProbe: probe.verdict,
        model,
        upstreamModel: probe.upstreamModel,
        lastFailure: probe.verdict === 'available' ? null : explain(probe),
    };
    if (!dryRun) writeWatchState(nextWatch);

    if (asJson) {
        console.log(JSON.stringify({ model, probe, alerts: alerts.length }));
    } else {
        console.log(
            `argon-watch: probe=${probe.verdict} upstream=${probe.upstreamModel} ${probe.latencyMs}ms | alerts=${alerts.length}`
        );
        for (const message of alerts) console.log(`  alert: ${message.split('\n')[0]}`);
        if (probe.verdict !== 'available') console.log(`  reason: ${explain(probe)}`);
    }
};

await main();
