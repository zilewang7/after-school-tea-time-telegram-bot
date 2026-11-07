/**
 * Control panel, phase 4 (docs/2026-1106-2321 §11): the issue panel through
 * the test domain. The driving userbot (a member of the test group) files an
 * issue on the group and reads the bot's notice back from the group; the
 * issue is listed; the synthetic owner from .env.test (an observer of the
 * group) triages it, while a member's PATCH is refused and a stranger cannot
 * even see it. The issue ends as wontfix, so test runs do not pile up open
 * issues.
 */
import { BOT_USER_ID, TEST_CHAT_ID, expect, readGroupMessages, sendAsUser, sleep, type DriverMessage } from './harness.mts';
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
    waitForPanel,
    type PanelAuth,
    type PanelResponse,
} from './panel-client.mts';
import type { E2eCase } from './suite-helpers.mts';

const NOTICE_POLL_ATTEMPTS = 20;
const NOTICE_POLL_INTERVAL_MS = 1500;
const TRIAGE_NOTE = 'e2e：已查看';

/** The bot's notice of issue #id among the group messages after `afterId`, polled for ~30s */
const waitForIssueNotice = async (afterId: number, issueId: number): Promise<DriverMessage | undefined> => {
    const marker = `通过控制面板提交了 issue #${issueId}`;
    for (let attempt = 0; attempt < NOTICE_POLL_ATTEMPTS; attempt++) {
        await sleep(NOTICE_POLL_INTERVAL_MS);
        const found = (await readGroupMessages(afterId)).find(
            (message) => message.sender_id === BOT_USER_ID && message.text.includes(marker)
        );
        if (found) return found;
    }
    return undefined;
};

/** A text-link entity whose URL is the issue's Direct Link (…?startapp=i<id>) */
const linksToIssue = (message: DriverMessage, issueId: number): boolean =>
    message.entities.some((entity) => {
        const url = entity['url'];
        return typeof url === 'string' && url.endsWith(`?startapp=i${issueId}`);
    });

const patchIssue = (issueId: number, auth: PanelAuth, body: Record<string, unknown>): Promise<PanelResponse> =>
    panelRequest(`/api/issues/${issueId}`, auth, { method: 'PATCH', body });

/** Close the case's issue; a failure is reported, not thrown, so it never hides the case's own error */
const closeIssue = async (issueId: number): Promise<void> => {
    try {
        const closed = await patchIssue(issueId, asUser(SYNTHETIC_OWNER), { status: 'wontfix' });
        if (closed.status !== 200) console.warn(`    ⚠ could not close issue #${issueId}: ${describe(closed)}`);
    } catch (error) {
        const problem = error instanceof Error ? error.message : String(error);
        console.warn(`    ⚠ could not close issue #${issueId}: ${problem}`);
    }
};

export const panelPhase4Cases: E2eCase[] = [
    {
        name: 'panel issues: a member files one, the group is told, the owner triages it',
        body: async () => {
            await waitForPanel();
            const member = await driverUser();
            // The notice must arrive after this message
            const anchor = await sendAsUser('面板 e2e：提交 issue 前的定位消息');
            const title = `e2e 面板提交的 issue ${Date.now()}`;
            const created = await panelRequest('/api/issues', asUser(member), {
                method: 'POST',
                body: {
                    chatId: TEST_CHAT_ID,
                    kind: 'bug',
                    severity: 'low',
                    title,
                    body: '端到端测试自动提交，用例结束时标记为 wontfix。',
                },
            });
            const issueId = fieldOf(created.body, 'issue', 'id');
            expect(
                created.status === 201 && typeof issueId === 'number',
                `POST /api/issues answers 201 with the issue (got ${describe(created)})`
            );
            if (typeof issueId !== 'number') return;

            try {
                expect(
                    fieldOf(created.body, 'issue', 'source') === 'user' &&
                        fieldOf(created.body, 'issue', 'createdBy', 'userId') === member.id &&
                        fieldOf(created.body, 'issue', 'chat', 'chatId') === TEST_CHAT_ID &&
                        fieldOf(created.body, 'issue', 'chatAccess') === 'member',
                    `the issue is the member's, on the test group (got ${describe(created)})`
                );

                const notice = await waitForIssueNotice(anchor, issueId);
                expect(Boolean(notice), `the bot tells the group about issue #${issueId}`);
                if (notice) {
                    expect(notice.text.includes(title), 'the notice carries the title');
                    expect(notice.has_buttons === false, 'the notice has no buttons');
                    expect(notice.reply_to === null, 'the notice is not a reply');
                    expect(
                        linksToIssue(notice, issueId),
                        `a link entity opens the issue in the panel (got ${JSON.stringify(notice.entities)})`
                    );
                }

                const listed = await panelRequest(`/api/issues?chatId=${TEST_CHAT_ID}&source=user`, asUser(member));
                expect(
                    listed.status === 200 &&
                        listOf(fieldOf(listed.body, 'issues')).some((issue) => fieldOf(issue, 'id') === issueId) &&
                        typeof fieldOf(listed.body, 'stats', 'total') === 'number',
                    `GET /api/issues lists it (got ${describe(listed)})`
                );

                const strangerView = await panelRequest(`/api/issues/${issueId}`, asUser(STRANGER));
                expect(
                    strangerView.status === 404 && errorCodeOf(strangerView) === 'not_found',
                    `a stranger cannot see it: 404 (got ${describe(strangerView)})`
                );

                const memberPatch = await patchIssue(issueId, asUser(member), { status: 'triaged' });
                expect(
                    memberPatch.status === 403 && errorCodeOf(memberPatch) === 'forbidden',
                    `a member cannot triage: 403 (got ${describe(memberPatch)})`
                );

                const ownerPatch = await patchIssue(issueId, asUser(SYNTHETIC_OWNER), {
                    status: 'triaged',
                    note: TRIAGE_NOTE,
                });
                expect(
                    ownerPatch.status === 200 &&
                        fieldOf(ownerPatch.body, 'issue', 'status') === 'triaged' &&
                        fieldOf(ownerPatch.body, 'issue', 'note') === TRIAGE_NOTE &&
                        fieldOf(ownerPatch.body, 'issue', 'chatAccess') === 'observer',
                    `the synthetic owner triages it as an observer (got ${describe(ownerPatch)})`
                );

                const memberView = await panelRequest(`/api/issues/${issueId}`, asUser(member));
                expect(
                    memberView.status === 200 && fieldOf(memberView.body, 'issue', 'status') === 'triaged',
                    `the member sees the new status (got ${describe(memberView)})`
                );
            } finally {
                await closeIssue(issueId);
            }
        },
    },
];
