#!/usr/bin/env node
/**
 * Watch how many bytes leave the private media bucket and SMS the operator when
 * it looks abnormal. The bucket is shared read-only with the hub's upstream
 * Vertex projects so gs:// large media keeps working; this is the tripwire that
 * makes handing that access out safe.
 *
 *   node scripts/guard/gcs-egress-guard.mjs             # normal run (timer)
 *   node scripts/guard/gcs-egress-guard.mjs --dry-run   # print numbers, never send
 *   node scripts/guard/gcs-egress-guard.mjs --test-alert
 *
 * Thresholds (rolling windows, GB) and cooldowns are env-overridable:
 *   GUARD_10MIN_GB=1  GUARD_1H_GB=2  GUARD_24H_GB=5
 *   GUARD_COOLDOWN_10MIN_MIN=30  GUARD_COOLDOWN_1H_MIN=180  GUARD_COOLDOWN_24H_MIN=1440
 */
import 'dotenv/config';
import {
    BYTES_PER_GB,
    REVOKE_HINT,
    envNumber,
    fetchAccessToken,
    formatGb,
    readState,
    requireCredentials,
    sendAlert,
    writeState,
} from './lib.mjs';

const WINDOWS = [
    { key: '10min', seconds: 600, threshold: 'GUARD_10MIN_GB', cooldown: 'GUARD_COOLDOWN_10MIN_MIN', defaultThreshold: 1, defaultCooldown: 30 },
    { key: '1h', seconds: 3600, threshold: 'GUARD_1H_GB', cooldown: 'GUARD_COOLDOWN_1H_MIN', defaultThreshold: 2, defaultCooldown: 180 },
    { key: '24h', seconds: 86400, threshold: 'GUARD_24H_GB', cooldown: 'GUARD_COOLDOWN_24H_MIN', defaultThreshold: 5, defaultCooldown: 1440 },
];
const ERROR_COOLDOWN_MS = 12 * 3600 * 1000;

const flags = new Set(process.argv.slice(2));
const dryRun = flags.has('--dry-run');
const testAlert = flags.has('--test-alert');

const metricUrl = (windowSeconds) => {
    const end = new Date();
    const start = new Date(end.getTime() - windowSeconds * 1000);
    const url = new URL(`https://monitoring.googleapis.com/v3/projects/${process.env.GOOGLE_CLOUD_PROJECT}/timeSeries`);
    url.searchParams.set(
        'filter',
        `metric.type="storage.googleapis.com/network/sent_bytes_count" AND resource.label.bucket_name="${process.env.GCS_BUCKET}"`
    );
    url.searchParams.set('interval.startTime', start.toISOString());
    url.searchParams.set('interval.endTime', end.toISOString());
    url.searchParams.set('aggregation.alignmentPeriod', `${windowSeconds}s`);
    url.searchParams.set('aggregation.perSeriesAligner', 'ALIGN_SUM');
    return url;
};

/** Bytes sent from the bucket over the last `windowSeconds`, via Cloud Monitoring. */
const fetchEgressBytes = async (token, windowSeconds) => {
    const response = await fetch(metricUrl(windowSeconds), { headers: { Authorization: `Bearer ${token}` } });
    const payload = await response.json();
    if (!response.ok) throw new Error(`monitoring API HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 200)}`);
    if (payload.error) throw new Error(`monitoring API: ${payload.error.message}`);

    return (payload.timeSeries ?? []).reduce((total, series) => {
        const latest = (series.points ?? [])[0];
        if (!latest) return total;
        return total + Number(latest.value?.int64Value ?? latest.value?.doubleValue ?? 0);
    }, 0);
};

const measure = async (token) => {
    const results = [];
    for (const window of WINDOWS) {
        const bytes = await fetchEgressBytes(token, window.seconds);
        const thresholdGb = envNumber(window.threshold, window.defaultThreshold);
        results.push({ ...window, bytes, thresholdGb, exceeded: bytes >= thresholdGb * BYTES_PER_GB });
    }
    return results;
};

const main = async () => {
    requireCredentials();
    if (!process.env.GCS_BUCKET || !process.env.GOOGLE_CLOUD_PROJECT) {
        throw new Error('GCS_BUCKET and GOOGLE_CLOUD_PROJECT are required');
    }

    const measured = await measure(await fetchAccessToken());
    const summary = measured.map((m) => `${m.key} ${formatGb(m.bytes)}/${m.thresholdGb}GB`).join(' | ');
    console.log(`${new Date().toISOString()} egress ${summary}`);

    if (testAlert) {
        if (dryRun) console.log('[dry-run] would send the test alert');
        else await sendAlert('k-on-bot 出流量护栏测试', `测试告警（非异常）。当前桶出流量：${summary}。`);
        return;
    }

    const state = readState();
    const now = Date.now();
    const toSend = [];

    for (const hit of measured.filter((m) => m.exceeded)) {
        const cooldownMs = envNumber(hit.cooldown, hit.defaultCooldown) * 60 * 1000;
        const previous = state.alerts?.[hit.key] ?? { lastSentAt: 0, count: 0 };
        if (now - previous.lastSentAt < cooldownMs) {
            console.log(`  ${hit.key} over threshold but inside cooldown; skip`);
            continue;
        }
        state.alerts = { ...state.alerts, [hit.key]: { lastSentAt: now, count: (previous.count ?? 0) + 1 } };
        toSend.push({ hit, count: (previous.count ?? 0) + 1 });
    }

    if (toSend.length === 0) return;
    writeState(state);
    const lines = toSend.map(({ hit, count }) => `${hit.key}: ${formatGb(hit.bytes)}（阈值 ${hit.thresholdGb}GB，第 ${count} 次）`);
    if (dryRun) {
        console.log(`[dry-run] would alert:\n${lines.join('\n')}`);
        return;
    }
    await sendAlert(
        'k-on-bot 桶出流量异常',
        [`桶 ${process.env.GCS_BUCKET} 出流量超阈值：`, ...lines, `全部窗口：${summary}`, `如确认异常，立即撤权：${REVOKE_HINT}`].join('\n')
    );
};

main().catch(async (error) => {
    const message = String(error?.message ?? error);
    console.error(`guard failed: ${message}`);
    try {
        const state = readState();
        if (!dryRun && Date.now() - (state.lastErrorAt ?? 0) > ERROR_COOLDOWN_MS) {
            state.lastErrorAt = Date.now();
            writeState(state);
            await sendAlert('k-on-bot 出流量护栏自身异常', `监控脚本运行失败，请检查：${message}`);
        }
    } catch (nested) {
        console.error(`could not raise an alert for the failure: ${String(nested?.message ?? nested)}`);
    }
    process.exit(1);
});
