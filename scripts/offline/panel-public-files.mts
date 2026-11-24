/**
 * Offline cases for the site's machine-readable declarations (harness #15,
 * design §4.3): a real `/robots.txt`, `/llms.txt`, and the JSON alternate a
 * share page advertises. The declarations allow the on-demand AI agents a user
 * starts to read a share link; they must not weaken the page's own noindex, and
 * the static catch-all must keep serving the SPA for every other path.
 *
 * Run: npx tsx scripts/offline/panel-public-files.mts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammyError } from 'grammy';
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';

const BOT_TOKEN = '123456789:AAFakeOfflineTokenForPublicFileTests_01';
const BOT_USER_ID = 9999;
const OWNER_ID = 4242;
const ALICE = 5001;
const GROUP = -1001000000008;
const OWN_ORIGIN = 'https://miniapp.test';

process.env.BOT_USER_ID = String(BOT_USER_ID);
process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.WEBAPP_PUBLIC_URL = OWN_ORIGIN;
process.env.WIDGET_RENDER_URL = '';
process.env.LUOXU_PREVIEW_URL = 'http://luoxu.test';

await setupOfflineDb();
const registry = await import('../../src/db/queries/panel-registry.js');
const db = await import('../../src/db/index.js');
const shareService = await import('../../src/panel/share/share-link-service.js');
const { createPanelApp } = await import('../../src/panel/app.js');

type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;
type PanelApp = ReturnType<typeof createPanelApp>;
type ResponseVersion = import('../../src/db/index.js').ResponseVersion;
type ShareLinkRecord = import('../../src/panel/share/share-types.js').ShareLinkRecord;

const scratch = mkdtempSync(join(tmpdir(), 'k-on-bot-public-files-'));
process.once('exit', () => rmSync(scratch, { recursive: true, force: true }));
const STATIC_ROOT = join(scratch, 'dist');
const INDEX_HTML = '<!doctype html><title>panel</title>';
mkdirSync(join(STATIC_ROOT, 'assets'), { recursive: true });
writeFileSync(join(STATIC_ROOT, 'index.html'), INDEX_HTML);

const grammyError = (code: number, description: string): GrammyError =>
    new GrammyError(`(${code}: ${description})`, { ok: false, error_code: code, description }, 'getChatMember', {});

const fakeLookup: MembershipLookup = async (chatId, userId) => {
    if (chatId === GROUP && userId === ALICE) return { status: 'member' };
    throw grammyError(400, 'Bad Request: user not found');
};

const makeApp = (shareEnabled: boolean): PanelApp =>
    createPanelApp({
        botToken: BOT_TOKEN,
        membershipLookup: fakeLookup,
        staticRoot: STATIC_ROOT,
        startedAt: new Date('2026-11-24T00:00:00.000Z'),
        version: 'abc1234',
        shareEnabled,
    });

const app = makeApp(true);
const disabledApp = makeApp(false);

await registry.upsertChatNow({ id: GROUP, type: 'supergroup', title: '主群' });

let nextMessageId = 30000;
const takeMessageId = (): number => {
    nextMessageId += 1;
    return nextMessageId;
};

const versionOf = (versionId: number, overrides: Partial<ResponseVersion> = {}): ResponseVersion => ({
    versionId,
    createdAt: '2026-11-24T12:00:00.000Z',
    messageIds: [900 + versionId],
    currentMessageId: 900 + versionId,
    text: '分享页正文',
    wasStoppedByUser: false,
    ...overrides,
});

/** One stored reply with one bot response; returns the share of its current version */
const replyShare = async (): Promise<ShareLinkRecord> => {
    const userMessageId = takeMessageId();
    await db.saveMessage({
        chatId: GROUP,
        messageId: userMessageId,
        userId: ALICE,
        date: new Date('2026-11-24T12:00:00.000Z'),
        userName: 'Alice',
        message: '分享页的问题',
    });
    const botMessageId = takeMessageId();
    await db.saveMessage({
        chatId: GROUP,
        messageId: botMessageId,
        userId: BOT_USER_ID,
        date: new Date('2026-11-24T12:00:00.000Z'),
        userName: 'k-on-bot',
        message: '',
        replyToId: userMessageId,
    });
    const response = await db.createBotResponse(GROUP, botMessageId, userMessageId, {
        model: 'offline-model',
        hasImage: false,
    });
    response.setVersions([versionOf(1, { model: 'offline-model' })]);
    response.currentVersionIndex = 0;
    await response.save();
    const created = await shareService.createUserShare({
        kind: 'reply',
        chatId: GROUP,
        firstMessageId: botMessageId,
        createdBy: ALICE,
    });
    if (!created.ok) throw new Error(`could not create the share: ${created.reason}`);
    return created.share;
};

const textOf = async (response: Response): Promise<string> => response.text();

/** The rule lines of one robots group (blank-line separated), comments removed */
const robotsGroupOf = (robots: string, userAgent: string): string[] => {
    const groups = robots.split(/\n\s*\n/);
    const group = groups.find((candidate) =>
        candidate.split('\n').some((line) => line.trim() === `User-agent: ${userAgent}`)
    );
    if (group === undefined) return [];
    return group
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'));
};

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: '/robots.txt is a real robots file, not the SPA',
        body: async () => {
            const response = await app.request('/robots.txt');
            const robots = await textOf(response);
            expect(response.status === 200, `200 (got ${response.status})`);
            expect(response.headers.get('Content-Type')?.startsWith('text/plain') === true, 'a text/plain body');
            expect(!robots.includes(INDEX_HTML), 'not the SPA index.html');
            expect(!robots.includes('<!doctype html>'), 'not an HTML document');
            expect(robots.includes('User-agent: *'), 'a default group');
            expect(robotsGroupOf(robots, '*').includes('Disallow: /s/'), 'search engines are kept out of /s/');
            expect(robotsGroupOf(robots, '*').includes('Disallow: /api/'), 'and out of /api');
            for (const agent of [
                'GoogleAgent-URLContext',
                'Google-Agent',
                'Google-CloudVertexBot',
                'Gemini-Deep-Research',
            ]) {
                const group = robotsGroupOf(robots, agent);
                expect(group.length > 0, `${agent} has its own group`);
                expect(group.includes('Allow: /s/'), `${agent} may read a share`);
            }
            expect(
                robotsGroupOf(robots, 'GoogleAgent-URLContext').includes('Allow: /api/public/shares/'),
                'the URL-context agent may read the JSON entry too'
            );
        },
    },
    {
        name: '/llms.txt explains the share pages and their read paths',
        body: async () => {
            const response = await app.request('/llms.txt');
            const llms = await textOf(response);
            expect(response.status === 200, `200 (got ${response.status})`);
            expect(response.headers.get('Content-Type')?.startsWith('text/plain') === true, 'a text/plain body');
            expect(!llms.includes(INDEX_HTML), 'not the SPA index.html');
            expect(llms.startsWith('# k-on-bot'), 'the title line');
            expect(llms.includes('/s/<token>'), 'the HTML read path');
            expect(llms.includes('/api/public/shares/<token>'), 'the JSON read path');
            expect(llms.includes('noindex'), 'the no-index rule is stated');
            expect(llms.includes('GoogleAgent-URLContext'), 'the on-demand agents are named');
        },
    },
    {
        name: 'the static catch-all still serves the SPA for other paths',
        body: async () => {
            const response = await app.request('/some/panel/page');
            const html = await textOf(response);
            expect(response.status === 200, `200 (got ${response.status})`);
            expect(html.includes(INDEX_HTML), 'the SPA index is served');
            const missing = await textOf(await app.request('/robots.txt'));
            expect(!missing.includes(INDEX_HTML), 'and /robots.txt no longer falls through to it');
        },
    },
    {
        name: 'a share page advertises its JSON alternate without losing noindex',
        body: async () => {
            const share = await replyShare();
            const response = await app.request(`/s/${share.token}`);
            const html = await textOf(response);
            const jsonUrl = `${OWN_ORIGIN}/api/public/shares/${share.token}`;
            expect(response.status === 200, `page 200 (got ${response.status})`);
            expect(
                response.headers.get('Link') === `<${jsonUrl}>; rel="alternate"; type="application/json"`,
                `the Link header (got ${String(response.headers.get('Link'))})`
            );
            expect(
                html.includes(`<link rel="alternate" type="application/json" href="${jsonUrl}">`),
                'the alternate link in the head'
            );
            expect(html.includes('<meta name="robots" content="noindex,nofollow">'), 'the page keeps its noindex meta');
            expect(response.headers.get('X-Robots-Tag') === 'noindex, nofollow', 'and its noindex header');

            const json = await app.request(`/api/public/shares/${share.token}`);
            expect(json.status === 200, `JSON 200 (got ${json.status})`);
            expect(json.headers.get('Cache-Control') === 'no-store', 'the JSON stays no-store');
            expect(json.headers.get('X-Robots-Tag') === 'noindex, nofollow', 'and noindex');
            const body: unknown = await json.json();
            const shareView =
                typeof body === 'object' && body !== null && 'share' in body ? body.share : undefined;
            expect(
                typeof shareView === 'object' && shareView !== null && 'token' in shareView && shareView.token === share.token,
                'the JSON names the same share'
            );
        },
    },
    {
        name: 'SHARE_ENABLED=0 keeps the declarations and 404s the share paths',
        body: async () => {
            const robots = await textOf(await disabledApp.request('/robots.txt'));
            const llms = await textOf(await disabledApp.request('/llms.txt'));
            expect(robotsGroupOf(robots, 'GoogleAgent-URLContext').includes('Allow: /s/'), 'the declarations stay');
            expect(llms.startsWith('# k-on-bot'), 'llms.txt stays a file');
            const share = await replyShare();
            expect((await disabledApp.request(`/s/${share.token}`)).status === 404, 'the page answers 404');
            expect((await disabledApp.request(`/api/public/shares/${share.token}`)).status === 404, 'so does the JSON');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) results.push(await runCase(testCase.name, testCase.body));
reportResults(results);
