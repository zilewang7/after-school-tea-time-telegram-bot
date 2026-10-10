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

const probe = async () => {
    // The guard always probes the hub, even when the bot itself runs elsewhere.
    const base = process.env.HUB_GEMINI_API_URL ?? process.env.GEMINI_API_URL;
    const key = process.env.HUB_GEMINI_API_KEY ?? process.env.GEMINI_API_KEY;
    const bucket = process.env.GCS_BUCKET;
    if (!base || !key || !bucket) throw new Error('HUB_GEMINI_API_URL, HUB_GEMINI_API_KEY and GCS_BUCKET are required');

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

    const response = await fetch(`${base}/v1beta/models/${probeModel}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body,
    });
    const text = await response.text();
    if (text.trimStart().startsWith('<')) return { kind: 'hub-error', detail: `HTTP ${response.status} (HTML)` };

    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        return { kind: 'hub-error', detail: `HTTP ${response.status} (unparsed body)` };
    }
    if (!payload.error) return { kind: 'authorised' };

    const message = String(payload.error.message ?? '');
    const serviceAgent = SA_PATTERN.exec(message)?.[0];
    if (serviceAgent) return { kind: 'needs-grant', serviceAgent, detail: message.slice(0, 200) };
    // "No such object" means the permission check passed and only the dummy name
    // was missing -- i.e. this channel is already covered.
    if (/not found|no such object|does not exist/i.test(message)) return { kind: 'authorised' };
    if (/marketplace budget/.test(message)) return { kind: 'hub-unavailable', detail: 'marketplace budget exhausted' };
    if (/requires billing/.test(message)) return { kind: 'hub-unavailable', detail: 'channel without billing' };
    return { kind: 'unknown', detail: message.slice(0, 200) };
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
        return;
    }

    const { serviceAgent } = result;
    if (!autoGrant) {
        if (!asJson) console.log(`probe: new upstream project ${serviceAgent}; auto-grant disabled`);
        await sendAlert(
            'k-on-bot 大文件需要授权新项目',
            [
                `hub 上游新项目需要桶读权限（自动授权已关闭）：`,
                serviceAgent,
                `手动授权：cd ~/dockers/k-on-bot && node scripts/guard/gcs-share.mjs grant --sa ${serviceAgent}`,
            ].join('\n')
        );
        return;
    }

    const { changed, binding } = await grantServiceAgent({ serviceAccount: serviceAgent, prefix: DEFAULT_PREFIX, dryRun });
    if (!asJson) {
        console.log(changed ? `granted ${serviceAgent}` : `already granted ${serviceAgent} (waiting for IAM to propagate)`);
    }
    if (!changed || dryRun) return;

    await sendAlert(
        'k-on-bot 已自动授权新的 hub 上游项目',
        [
            `为保持 >20MB 大文件可用，已给新的上游项目开通桶只读权限：`,
            serviceAgent,
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
