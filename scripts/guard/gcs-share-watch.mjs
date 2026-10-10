#!/usr/bin/env node
/**
 * Keep the gs:// large-media path working.
 *
 * The hub balances across several upstream GCP projects, each with its own
 * AiPlatform service agent, and new projects can join the pool over time. A
 * single grant is therefore not enough: this script asks the hub to open a
 * throwaway object (a dummy name under media/ costs nothing -- an unauthorised
 * project answers 403 and names its service agent, an authorised one answers
 * 404) and grants read-only access to any service agent that is not covered yet.
 * Every automatic grant is announced by SMS, so the operator always knows which
 * project just gained access.
 *
 * Both request modes are probed, because they route to different candidate
 * sets: the bot streams (streamGenerateContent) while a non-streaming probe can
 * land on channels the bot never uses. The large-media key is preferred when
 * configured, since the bot sends gs:// media through that key.
 *
 *   node scripts/guard/gcs-share-watch.mjs [--dry-run] [--force] [--json]
 *
 * Env: GUARD_WATCH_INTERVAL_MIN=30 (throttle), GUARD_AUTO_GRANT=1 (0 = alert
 * only), GUARD_PROBE_MODEL=gemini-3.1-pro-preview.
 */
import 'dotenv/config';
import {
    DEFAULT_PREFIX,
    DEFAULT_ROLE,
    REVOKE_HINT,
    SA_PATTERN,
    envNumber,
    grantServiceAgent,
    readState,
    requireCredentials,
    sendAlert,
    writeState,
} from './lib.mjs';

const flags = new Set(process.argv.slice(2));
const dryRun = flags.has('--dry-run');
const force = flags.has('--force');
const asJson = flags.has('--json');
const autoGrant = (process.env.GUARD_AUTO_GRANT ?? '1') !== '0';
const intervalMinutes = envNumber('GUARD_WATCH_INTERVAL_MIN', 30);

const probeModel = process.env.GUARD_PROBE_MODEL ?? 'gemini-3.1-pro-preview';

/** The dedicated key for requests that carry gs:// media, when one is set. */
const probeTarget = () => {
    // Probe the host large media actually uses (the primary host's CDN cuts long
    // requests at 100s), falling back to the bot's endpoint.
    const base =
        process.env.GEMINI_LARGE_MEDIA_API_URL ??
        process.env.HUB_GEMINI_API_URL ??
        process.env.GEMINI_API_URL;
    const key =
        process.env.GEMINI_LARGE_MEDIA_API_KEY ??
        process.env.HUB_GEMINI_API_KEY ??
        process.env.GEMINI_API_KEY;
    const bucket = process.env.GCS_BUCKET;
    if (!base || !key || !bucket) {
        throw new Error('HUB_GEMINI_API_URL, GEMINI_LARGE_MEDIA_API_KEY (or GEMINI_API_KEY) and GCS_BUCKET are required');
    }
    return { base, key, bucket };
};

const classify = (status, text) => {
    if (text.trimStart().startsWith('<')) return { kind: 'hub-error', detail: `HTTP ${status} (HTML)` };
    const serviceAgent = SA_PATTERN.exec(text)?.[0];
    if (serviceAgent) return { kind: 'needs-grant', serviceAgent, detail: text.slice(0, 200) };
    // Non-Vertex channels (AI Studio style) reject gs:// references outright: the
    // probe key is not bound to a Vertex pool, so large media would break.
    if (/Google Cloud Storage files directly is not supported/i.test(text)) {
        return { kind: 'gs-unsupported', detail: 'channel cannot serve gs:// media' };
    }
    // "No such object" means the permission check passed and only the dummy name
    // was missing -- i.e. this channel is already covered.
    if (/not found|no such object|does not exist/i.test(text)) return { kind: 'authorised' };
    if (/marketplace budget/.test(text)) return { kind: 'hub-unavailable', detail: 'marketplace budget exhausted' };
    if (/requires billing/.test(text)) return { kind: 'hub-unavailable', detail: 'channel without billing' };
    return { kind: 'unknown', detail: text.slice(0, 200) };
};

const probeOnce = async ({ base, key, bucket, streaming }) => {
    const body = JSON.stringify({
        contents: [
            {
                role: 'user',
                parts: [
                    { text: 'hi' },
                    { fileData: { mimeType: 'video/mp4', fileUri: `gs://${bucket}/media/__guard_probe_nonexistent.mp4` } },
                ],
            },
        ],
    });
    const suffix = streaming ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const response = await fetch(`${base}/v1beta/models/${probeModel}:${suffix}`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body,
    });
    const text = await response.text();
    return { ...classify(response.status, text), streaming };
};

const probe = async () => {
    const target = probeTarget();
    const results = [];
    // Sequential on purpose: the first probe may already identify an un-granted
    // project, and the second only matters for the mode that was missed.
    for (const streaming of [true, false]) results.push(await probeOnce({ ...target, streaming }));

    const discovered = [...new Set(results.filter((r) => r.kind === 'needs-grant').map((r) => r.serviceAgent))];
    if (discovered.length > 0) return { kind: 'needs-grant', serviceAgents: discovered, results };
    if (results.every((r) => r.kind === 'authorised')) return { kind: 'authorised', results };
    if (results.every((r) => r.kind === 'gs-unsupported')) {
        return { kind: 'gs-unsupported', detail: 'the probed key is not bound to a Vertex pool', results };
    }
    if (results.every((r) => r.kind === 'hub-unavailable' || r.kind === 'hub-error')) {
        return { kind: 'hub-unavailable', detail: results.map((r) => r.detail).join('; '), results };
    }
    return {
        kind: 'unknown',
        detail: results.map((r) => `${r.streaming ? 'stream' : 'plain'}:${r.kind}${r.detail ? ` (${r.detail})` : ''}`).join('; '),
        results,
    };
};

/** Alert only when the probe enters a degraded state, not on every run. */
const reportDegraded = async (state, result) => {
    const previous = state.shareWatch?.lastKind;
    state.shareWatch = { ...state.shareWatch, lastKind: result.kind };
    writeState(state);
    if (result.kind === 'authorised' || previous === result.kind) return;
    if (result.kind !== 'gs-unsupported' && result.kind !== 'unknown') return;
    await sendAlert(
        'k-on-bot 大文件通道异常',
        [
            '共享授权巡检发现 gs:// 大文件链路可能不可用：',
            `状态 ${result.kind}${result.detail ? ` — ${result.detail}` : ''}`,
            '检查 .env 的 GEMINI_LARGE_MEDIA_API_KEY 是否指向 Vertex 类渠道的 key。',
        ].join('\n')
    );
};

const main = async () => {
    requireCredentials();

    const state = readState();
    const lastRunAt = state.shareWatch?.lastRunAt ?? 0;
    const elapsedMinutes = (Date.now() - lastRunAt) / 60000;
    if (!force && elapsedMinutes < intervalMinutes) {
        if (!asJson) console.log(`skipped: last probe ${elapsedMinutes.toFixed(1)} min ago (< ${intervalMinutes} min)`);
        return;
    }
    state.shareWatch = { ...state.shareWatch, lastRunAt: Date.now() };
    writeState(state);

    const result = await probe();
    if (asJson) console.log(JSON.stringify(result));

    if (result.kind !== 'needs-grant') {
        if (!asJson) console.log(`probe: ${result.kind}${result.detail ? ` (${result.detail})` : ''}`);
        await reportDegraded(state, result);
        return;
    }

    const { serviceAgents } = result;
    const listed = serviceAgents.join('\n');
    if (!autoGrant) {
        if (!asJson) console.log(`probe: new upstream project(s); auto-grant disabled\n${listed}`);
        await sendAlert(
            'k-on-bot 大文件需要授权新项目',
            [
                'hub 上游新项目需要桶读权限（自动授权已关闭）：',
                listed,
                '手动授权：cd ~/dockers/k-on-bot && node scripts/guard/gcs-share.mjs grant --sa <SA>',
            ].join('\n')
        );
        return;
    }

    const granted = [];
    for (const serviceAgent of serviceAgents) {
        const { changed } = await grantServiceAgent({ serviceAccount: serviceAgent, prefix: DEFAULT_PREFIX, dryRun });
        if (!asJson) console.log(changed ? `granted ${serviceAgent}` : `already granted ${serviceAgent} (waiting for IAM to propagate)`);
        if (changed && !dryRun) granted.push(serviceAgent);
    }
    if (granted.length === 0 || dryRun) return;

    await sendAlert(
        'k-on-bot 已自动授权新的 hub 上游项目',
        [
            '为保持 >20MB 大文件可用，已给新的上游项目开通桶只读权限：',
            granted.join('\n'),
            `角色 ${DEFAULT_ROLE}（仅 objects.get，不可枚举），限 ${DEFAULT_PREFIX} 前缀。`,
            `全部撤销：${REVOKE_HINT}`,
        ].join('\n')
    );
};

main().catch(async (error) => {
    console.error(`share watch failed: ${String(error?.message ?? error)}`);
    if (!dryRun) {
        try {
            await sendAlert('k-on-bot 共享授权巡检异常', `巡检脚本运行失败：${String(error?.message ?? error)}`);
        } catch (nested) {
            console.error(`could not alert: ${String(nested?.message ?? nested)}`);
        }
    }
    process.exit(1);
});
