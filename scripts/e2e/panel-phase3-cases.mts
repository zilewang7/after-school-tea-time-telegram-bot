/**
 * Control panel, phase 3 (docs/2026-1106-2321 §11, appendix B): the usage
 * probes and the statistics / status API, on the test bot.
 *
 * One probe per platform with a cheap, fast model: switch the test group to
 * it through the panel, send a short message, wait for the reply and read its
 * reply_metrics row from the test database. The row must name the model and
 * platform, be `ok` on version 1 with both timings, and carry prompt and
 * output tokens — appendix B names no platform that reports none, so a null
 * here is a finding (usually the relay dropping usage). Each probe prints the
 * row's token columns: the "to be probed" fields of appendix B (cached,
 * thoughts, cache writes) are checked by reading those lines. Every probe
 * puts the group's model back.
 *
 * Not registered in run.mts yet: `...panelPhase3Cases` goes after the phase 1
 * panel cases.
 */
import {
    BOT_USERNAME,
    TEST_CHAT_ID,
    expect,
    readReplyMetrics,
    sendAsUser,
    sleep,
    waitForBotResponse,
    type StoredReplyMetric,
} from './harness.mts';
import {
    STRANGER,
    SYNTHETIC_OWNER,
    asUser,
    describe,
    driverUser,
    errorCodeOf,
    fieldOf,
    listOf,
    panelRequest,
    type PanelAuth,
    type PanelResponse,
} from './panel-client.mts';
import type { E2eCase } from './suite-helpers.mts';

const CHAT_PATH = `/api/chats/${TEST_CHAT_ID}`;
const REPLY_TIMEOUT_MS = 180_000;
/** The row is written right after the reply leaves `processing` */
const METRICS_TIMEOUT_MS = 15_000;

interface UsageProbe {
    readonly model: string;
    readonly platform: string;
}

/** Appendix B, one per platform; OpenAI and Anthropic go through the relay */
const USAGE_PROBES: readonly UsageProbe[] = [
    { model: 'gemini-3.8-flash', platform: 'gemini' },
    { model: 'gpt-6-luna', platform: 'openai' },
    { model: 'claude-sonnet-5-5', platform: 'anthropic' },
    { model: 'deepseek-flash', platform: 'deepseek' },
    { model: 'mimo-v2.6-flash', platform: 'mimo' },
    { model: 'grok-4.7', platform: 'grok' },
];

const STATS_KEYS = [
    'bucket',
    'chatId',
    'chats',
    'cost',
    'costGroups',
    'errorKinds',
    'from',
    'kpis',
    'models',
    'outcomes',
    'pricing',
    'range',
    'recentErrors',
    'series',
    'timeZone',
    'to',
    'tools',
];

const patchSettings = (auth: PanelAuth, patch: Record<string, unknown>): Promise<PanelResponse> =>
    panelRequest(`${CHAT_PATH}/settings`, auth, { method: 'PATCH', body: patch });

/** Put the model back; a failure is reported, never thrown over the case's own error */
const restoreModel = async (auth: PanelAuth, model: unknown): Promise<void> => {
    try {
        const restored = await patchSettings(auth, { model: typeof model === 'string' ? model : null });
        if (restored.status !== 200) console.warn(`    ⚠ could not restore the model: ${describe(restored)}`);
    } catch (error) {
        console.warn(`    ⚠ could not restore the model: ${error instanceof Error ? error.message : String(error)}`);
    }
};

const waitForMetrics = async (firstMessageId: number): Promise<StoredReplyMetric[]> => {
    const deadline = Date.now() + METRICS_TIMEOUT_MS;
    let rows: StoredReplyMetric[] = [];
    while (Date.now() < deadline) {
        rows = await readReplyMetrics(firstMessageId);
        if (rows.length > 0) return rows;
        await sleep(1000);
    }
    return rows;
};

const usageLine = (row: StoredReplyMetric): string =>
    `prompt=${row.promptTokens} cached=${row.cachedTokens} cacheWrite=${row.cacheWriteTokens} ` +
    `output=${row.outputTokens} thoughts=${row.thoughtsTokens} imageOutput=${row.imageOutputTokens} ` +
    `rounds=${row.rounds} route=${row.route} context=${row.contextMessages}/${row.contextImages}`;

const probeCase = (probe: UsageProbe): E2eCase => ({
    name: `panel phase 3: ${probe.model} reports its usage into reply_metrics`,
    body: async () => {
        const member = await driverUser();
        const dashboard = await panelRequest(CHAT_PATH, asUser(member));
        expect(dashboard.status === 200, `the dashboard opens (got ${describe(dashboard)})`);
        const previousModel = fieldOf(dashboard.body, 'settings', 'model');
        const switched = await patchSettings(asUser(member), { model: probe.model });
        expect(switched.status === 200, `the group switches to ${probe.model} (got ${describe(switched)})`);
        try {
            const trigger = await sendAsUser(`@${BOT_USERNAME} 请只回复两个字：收到`);
            const response = await waitForBotResponse(trigger, REPLY_TIMEOUT_MS);
            expect(!response.errorMessage, `the reply did not fail (got: ${response.errorMessage ?? ''})`);

            const rows = await waitForMetrics(response.firstMessageId);
            const [row] = rows;
            expect(rows.length === 1 && row !== undefined, `one reply_metrics row for the reply (got ${rows.length})`);
            if (row === undefined) return;
            console.log(`    · ${probe.model}: ${usageLine(row)}`);
            expect(
                row.model === probe.model && row.platform === probe.platform && row.commandType === 'chat',
                `model and platform recorded (got ${row.model} / ${row.platform})`
            );
            expect(row.outcome === 'ok' && row.errorKind === null && row.versionId === 1, `ok on version 1 (got ${row.outcome} v${row.versionId})`);
            expect(row.requestStartedAt !== null && row.firstChunkAt !== null, 'request and first-chunk times recorded');
            expect((row.rounds ?? 0) >= 1, `at least one round reported (got ${row.rounds})`);
            expect(
                row.promptTokens !== null && row.outputTokens !== null,
                `prompt and output tokens reported (got ${usageLine(row)})`
            );
            expect(
                (row.cachedTokens === null || row.cachedTokens <= (row.promptTokens ?? 0)) &&
                    (row.thoughtsTokens === null || row.thoughtsTokens <= (row.outputTokens ?? 0)),
                'cache hits sit inside the prompt, thoughts inside the output'
            );
        } finally {
            await restoreModel(asUser(member), previousModel);
        }
    },
});

const statsCase: E2eCase = {
    name: 'panel phase 3: statistics, live status and the 7-day summary by access level',
    body: async () => {
        const member = await driverUser();
        const statsPath = `/api/stats?chatId=${TEST_CHAT_ID}&range=24h`;

        const memberStats = await panelRequest(statsPath, asUser(member));
        expect(memberStats.status === 200, `a member reads the group's statistics (got ${describe(memberStats)})`);
        const keys = Object.keys(typeof memberStats.body === 'object' && memberStats.body !== null ? memberStats.body : {}).sort();
        expect(JSON.stringify(keys) === JSON.stringify(STATS_KEYS), `the documented top-level keys (got ${JSON.stringify(keys)})`);
        expect(
            fieldOf(memberStats.body, 'bucket') === 'hour' && listOf(fieldOf(memberStats.body, 'series', 'buckets')).length >= 24,
            '24h is hourly'
        );
        const replies = fieldOf(memberStats.body, 'kpis', 'replies');
        expect(typeof replies === 'number' && replies >= 1, `the probes' replies are counted (got ${String(replies)})`);
        const models = listOf(fieldOf(memberStats.body, 'models')).map((row) => fieldOf(row, 'model'));
        expect(
            USAGE_PROBES.some((probe) => models.includes(probe.model)),
            `the per-model table names the probed models (got ${JSON.stringify(models)})`
        );
        const memberText = JSON.stringify(memberStats.body);
        expect(!memberText.includes('triggerUserId') && !memberText.includes(String(member.id)), 'no user id in the statistics');

        const observerStats = await panelRequest(statsPath, asUser(SYNTHETIC_OWNER));
        expect(observerStats.status === 200, `the observing owner reads them too (got ${describe(observerStats)})`);
        expect(!JSON.stringify(observerStats.body).includes(String(member.id)), "the observer sees nobody's id");
        const strangerStats = await panelRequest(statsPath, asUser(STRANGER));
        expect(strangerStats.status === 403 && errorCodeOf(strangerStats) === 'forbidden', `a stranger is refused (got ${describe(strangerStats)})`);
        const memberGlobal = await panelRequest('/api/stats', asUser(member));
        expect(memberGlobal.status === 403, `all-chats statistics are owner only (got ${describe(memberGlobal)})`);
        const ownerGlobal = await panelRequest('/api/stats?range=7d', asUser(SYNTHETIC_OWNER));
        expect(
            ownerGlobal.status === 200 && Array.isArray(fieldOf(ownerGlobal.body, 'chats')),
            `the owner gets every chat with per-chat rows (got ${describe(ownerGlobal)})`
        );
        const badRange = await panelRequest(`/api/stats?chatId=${TEST_CHAT_ID}&range=1y`, asUser(member));
        expect(badRange.status === 400 && errorCodeOf(badRange) === 'invalid', `an unknown range is 400 (got ${describe(badRange)})`);

        const ownerStatus = await panelRequest('/api/status', asUser(SYNTHETIC_OWNER));
        expect(
            ownerStatus.status === 200 &&
                fieldOf(ownerStatus.body, 'process', 'online') === true &&
                fieldOf(ownerStatus.body, 'process', 'testInstance') === true &&
                typeof fieldOf(ownerStatus.body, 'process', 'globalDefaultModel') === 'string' &&
                Array.isArray(fieldOf(ownerStatus.body, 'process', 'mcpServers')),
            `the owner gets the process facts (got ${describe(ownerStatus)})`
        );
        const memberStatus = await panelRequest('/api/status', asUser(member));
        expect(
            memberStatus.status === 200 &&
                fieldOf(memberStatus.body, 'process') === null &&
                Array.isArray(fieldOf(memberStatus.body, 'active')) &&
                Array.isArray(fieldOf(memberStatus.body, 'recentErrors')),
            `a member gets live replies and errors, no process facts (got ${describe(memberStatus)})`
        );
        const strangerStatus = await panelRequest('/api/status', asUser(STRANGER));
        expect(
            listOf(fieldOf(strangerStatus.body, 'active')).length === 0 &&
                listOf(fieldOf(strangerStatus.body, 'recentErrors')).length === 0,
            `a stranger sees nothing live (got ${describe(strangerStatus)})`
        );

        const dashboard = await panelRequest(CHAT_PATH, asUser(member));
        const summaryReplies = fieldOf(dashboard.body, 'summary', 'replies');
        expect(
            typeof summaryReplies === 'number' &&
                summaryReplies >= 1 &&
                fieldOf(dashboard.body, 'summary', 'days') === 7 &&
                fieldOf(dashboard.body, 'summary', 'costUsd') !== undefined,
            `the dashboard has its 7-day summary (got ${JSON.stringify(fieldOf(dashboard.body, 'summary'))})`
        );
    },
};

export const panelPhase3Cases: E2eCase[] = [...USAGE_PROBES.map(probeCase), statsCase];
