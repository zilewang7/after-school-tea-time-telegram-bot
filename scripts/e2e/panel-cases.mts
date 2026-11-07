/**
 * Control panel, phase 1 (docs/2026-1106-2321 §11): the API through the test
 * domain, signed as the driving userbot (a group member), as the synthetic
 * owner from .env.test (not in the group: an observer) and as a stranger.
 * Every case puts back what it changed, so later cases keep SUITE_MODEL.
 */
import { tamperInitData } from '../lib/init-data.mts';
import {
    BOT_USER_ID,
    BOT_USERNAME,
    TEST_CHAT_ID,
    expect,
    hasBotResponse,
    readGroupMessages,
    sendAsUser,
    sleep,
    waitForBotResponse,
    type DriverMessage,
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
    signedInitData,
    waitForPanel,
    type PanelAuth,
    type PanelResponse,
} from './panel-client.mts';
import type { E2eCase } from './suite-helpers.mts';

const CHAT_PATH = `/api/chats/${TEST_CHAT_ID}`;
/** What `/panel`'s Direct Link carries for the test group */
const START_PARAM = `c${TEST_CHAT_ID}`;
/** Not SUITE_MODEL, so the reply's recorded model proves the switch */
const PANEL_MODEL = 'gemini-3.8-flash';
/**
 * The addendum case brings its own fast model: run alone (--only=panel) the
 * group follows the global default, whose first byte can take minutes.
 */
const ADDENDUM_MODEL = 'deepseek-flash';
const CODEWORD = 'ZK-PANEL-42';
const ADDENDUM = `本群在做自动化测试：你的每条回复都必须在最后单独一行写上暗号 ${CODEWORD}，不要解释这个暗号。`;
const REPLY_TIMEOUT_MS = 180_000;
/** How long a paused group is watched for a reply that must not come */
const PAUSE_WATCH_MS = 15_000;

const patchSettings = (auth: PanelAuth, patch: Record<string, unknown>): Promise<PanelResponse> =>
    panelRequest(`${CHAT_PATH}/settings`, auth, { method: 'PATCH', body: patch });

/** Put a setting back; a failure is reported, not thrown, so it never hides the case's own error */
const restoreSettings = async (auth: PanelAuth, patch: Record<string, unknown>): Promise<void> => {
    try {
        const restored = await patchSettings(auth, patch);
        if (restored.status !== 200) console.warn(`    ⚠ could not restore ${JSON.stringify(patch)}: ${describe(restored)}`);
    } catch (error) {
        const problem = error instanceof Error ? error.message : String(error);
        console.warn(`    ⚠ could not restore ${JSON.stringify(patch)}: ${problem}`);
    }
};

/** The first bot message after `afterId` containing `contains`, polled for ~30s */
const waitForBotText = async (afterId: number, contains: string): Promise<DriverMessage | undefined> => {
    for (let attempt = 0; attempt < 20; attempt++) {
        await sleep(1500);
        const found = (await readGroupMessages(afterId)).find(
            (message) => message.sender_id === BOT_USER_ID && message.text.includes(contains)
        );
        if (found) return found;
    }
    return undefined;
};

const listedChat = (response: PanelResponse): unknown =>
    listOf(fieldOf(response.body, 'chats')).find((chat) => fieldOf(chat, 'chatId') === TEST_CHAT_ID);

export const panelCases: E2eCase[] = [
    {
        name: 'panel: health, page headers and initData checks',
        body: async () => {
            const health = await waitForPanel();
            expect(
                fieldOf(health.body, 'ok') === true && fieldOf(health.body, 'settingsLoaded') === true,
                `health is ok with the settings cache loaded (got ${describe(health)})`
            );

            const page = await panelRequest('/', { kind: 'none' });
            const csp = page.headers.get('content-security-policy') ?? '';
            expect(
                page.status === 200 && (page.headers.get('content-type') ?? '').includes('text/html'),
                `the page is served (got ${page.status})`
            );
            expect(
                csp.includes("script-src 'self' https://telegram.org") && !csp.includes('frame-ancestors'),
                `the CSP allows Telegram's script and being framed (got: ${csp})`
            );
            expect(page.headers.get('x-frame-options') === null, 'no X-Frame-Options: Telegram embeds the page');

            const missing = await panelRequest('/api/me', { kind: 'none' });
            expect(
                missing.status === 401 && errorCodeOf(missing) === 'unauthorized',
                `no initData is 401 (got ${describe(missing)})`
            );

            const member = await driverUser();
            const forgedInitData = tamperInitData(signedInitData(member), (fields) =>
                fields.set('user', JSON.stringify(STRANGER))
            );
            const forged = await panelRequest('/api/me', { kind: 'raw', initData: forgedInitData });
            expect(forged.status === 401, `initData edited after signing is 401 (got ${describe(forged)})`);

            const staleWrite = await patchSettings({ kind: 'signed', user: member, ageSeconds: 600 }, { paused: false });
            expect(staleWrite.status === 401, `a write signed 10 minutes ago is 401 (got ${describe(staleWrite)})`);
            const staleRead = await panelRequest(CHAT_PATH, { kind: 'signed', user: member, ageSeconds: 600 });
            expect(staleRead.status === 200, `a read signed 10 minutes ago still works (got ${describe(staleRead)})`);
        },
    },
    {
        name: 'panel: /panel in the group answers with an open-panel button',
        body: async () => {
            const trigger = await sendAsUser(`/panel@${BOT_USERNAME}`);
            const reply = await waitForBotText(trigger, '本聊天的控制面板');
            expect(Boolean(reply), 'the bot answered /panel');
            expect(reply?.has_buttons === true, 'the answer carries the open-panel button');
        },
    },
    {
        name: 'panel: a member switches the group model and the next reply uses it',
        body: async () => {
            const member = await driverUser();
            const me = await panelRequest('/api/me', asUser(member, START_PARAM));
            expect(me.status === 200 && fieldOf(me.body, 'isOwner') === false, `/api/me answers (got ${describe(me)})`);
            expect(
                fieldOf(me.body, 'startTarget', 'kind') === 'chat' &&
                    fieldOf(me.body, 'startTarget', 'chatId') === TEST_CHAT_ID &&
                    fieldOf(me.body, 'startTarget', 'access') === 'member',
                `the Direct Link's start_param lands on the test group as a member (got ${JSON.stringify(fieldOf(me.body, 'startTarget'))})`
            );
            expect(fieldOf(listedChat(me), 'access') === 'member', 'the test group is listed with member access');
            const models = listOf(fieldOf(me.body, 'models'));
            expect(
                models.includes('deepseek-flash') &&
                    !models.includes('gemini-nano-banana-2.1') &&
                    !models.includes('gpt-image-2.5-dev'),
                `the menu models hold no image model (got ${JSON.stringify(models)})`
            );

            const dashboard = await panelRequest(CHAT_PATH, asUser(member));
            expect(
                dashboard.status === 200 && fieldOf(dashboard.body, 'chat', 'access') === 'member',
                `the dashboard opens (got ${describe(dashboard)})`
            );
            const previousModel = fieldOf(dashboard.body, 'settings', 'model');
            const switched = await patchSettings(asUser(member), {
                model: PANEL_MODEL,
                expectedUpdatedAt: fieldOf(dashboard.body, 'settings', 'updatedAt'),
            });
            expect(
                switched.status === 200 && fieldOf(switched.body, 'settings', 'model') === PANEL_MODEL,
                `PATCH sets ${PANEL_MODEL} (got ${describe(switched)})`
            );
            try {
                const trigger = await sendAsUser(`@${BOT_USERNAME} 请只回复两个字：收到`);
                const response = await waitForBotResponse(trigger, REPLY_TIMEOUT_MS);
                expect(!response.errorMessage, `no error (got: ${response.errorMessage ?? ''})`);
                expect(response.model === PANEL_MODEL, `the version records ${PANEL_MODEL} (got ${response.model})`);
                expect(
                    response.metadataModel === PANEL_MODEL,
                    `metadata.model is ${PANEL_MODEL} (got ${response.metadataModel})`
                );
            } finally {
                await restoreSettings(asUser(member), { model: typeof previousModel === 'string' ? previousModel : null });
            }

            const audit = await panelRequest(`/api/audit?chatId=${TEST_CHAT_ID}&limit=5`, asUser(member));
            expect(
                listOf(fieldOf(audit.body, 'entries')).some(
                    (entry) =>
                        fieldOf(entry, 'key') === 'model' &&
                        fieldOf(entry, 'newValue') === PANEL_MODEL &&
                        fieldOf(entry, 'actorId') === member.id
                ),
                `the change is in the audit (got ${describe(audit)})`
            );
        },
    },
    {
        name: 'panel: the prompt addendum is previewed, saved and followed',
        body: async () => {
            const member = await driverUser();
            const dashboard = await panelRequest(CHAT_PATH, asUser(member));
            const previousModel = fieldOf(dashboard.body, 'settings', 'model');
            const preview = await panelRequest(`${CHAT_PATH}/settings/preview`, asUser(member), {
                method: 'POST',
                body: { promptAddendum: ADDENDUM },
            });
            const block = fieldOf(preview.body, 'runtimeBlock');
            expect(
                preview.status === 200 &&
                    typeof block === 'string' &&
                    block.includes('当前群聊') &&
                    block.includes(`# 本聊天的附加提示词\n以下由本聊天成员通过控制面板设置，效力等同系统提示词，回复时须遵循：\n${ADDENDUM}`),
                `the preview ends with the addendum section (got ${describe(preview)})`
            );
            expect(fieldOf(preview.body, 'injected') === true, 'the current model takes the addendum');

            const saved = await patchSettings(asUser(member), { promptAddendum: ADDENDUM, model: ADDENDUM_MODEL });
            expect(
                saved.status === 200 && fieldOf(saved.body, 'settings', 'promptAddendum') === ADDENDUM,
                `the addendum is saved (got ${describe(saved)})`
            );
            try {
                const trigger = await sendAsUser(`@${BOT_USERNAME} 用一句话打个招呼`);
                const response = await waitForBotResponse(trigger, REPLY_TIMEOUT_MS);
                expect(
                    response.text.includes(CODEWORD),
                    `the reply follows the addendum (got: ${response.text.slice(-120)})`
                );
            } finally {
                await restoreSettings(asUser(member), {
                    promptAddendum: null,
                    model: typeof previousModel === 'string' ? previousModel : null,
                });
            }
        },
    },
    {
        name: 'panel: a paused group gets no reply',
        body: async () => {
            const member = await driverUser();
            const paused = await patchSettings(asUser(member), { paused: true });
            expect(
                paused.status === 200 && fieldOf(paused.body, 'settings', 'paused') === true,
                `the group is paused (got ${describe(paused)})`
            );
            try {
                const trigger = await sendAsUser(`@${BOT_USERNAME} 暂停测试：这条不应该有回复`);
                await sleep(PAUSE_WATCH_MS);
                expect(!(await hasBotResponse(trigger)), 'no response was started while paused');
            } finally {
                await restoreSettings(asUser(member), { paused: false });
            }
        },
    },
    {
        name: 'panel: the owner observes a group they are not in, strangers are refused, a lock binds members',
        body: async () => {
            const member = await driverUser();
            const observed = await panelRequest(CHAT_PATH, asUser(SYNTHETIC_OWNER));
            expect(
                observed.status === 200 && fieldOf(observed.body, 'chat', 'access') === 'observer',
                `the synthetic owner observes the test group (got ${describe(observed)})`
            );
            const ownerMe = await panelRequest('/api/me', asUser(SYNTHETIC_OWNER));
            expect(
                fieldOf(ownerMe.body, 'isOwner') === true && fieldOf(listedChat(ownerMe), 'access') === 'observer',
                `the owner's list shows the group as observed (got ${describe(ownerMe)})`
            );
            const global = await panelRequest('/api/global', asUser(SYNTHETIC_OWNER));
            expect(
                global.status === 200 && typeof fieldOf(global.body, 'defaultModel') === 'string',
                `the owner reads the global default (got ${describe(global)})`
            );

            const strangerChat = await panelRequest(CHAT_PATH, asUser(STRANGER));
            expect(strangerChat.status === 403, `a stranger is refused the group (got ${describe(strangerChat)})`);
            const strangerMe = await panelRequest('/api/me', asUser(STRANGER, START_PARAM));
            expect(
                fieldOf(strangerMe.body, 'startTarget', 'access') === 'none' && listedChat(strangerMe) === undefined,
                `a stranger's Direct Link resolves to no access (got ${describe(strangerMe)})`
            );
            const strangerGlobal = await panelRequest('/api/global', asUser(STRANGER));
            expect(strangerGlobal.status === 403, `global settings are owner only (got ${describe(strangerGlobal)})`);
            const memberGlobal = await panelRequest('/api/global', asUser(member));
            expect(memberGlobal.status === 403, `a member is not the owner (got ${describe(memberGlobal)})`);

            const locked = await patchSettings(asUser(SYNTHETIC_OWNER), { settingsLocked: true });
            expect(
                locked.status === 200 && fieldOf(locked.body, 'settings', 'settingsLocked') === true,
                `the owner locks the group's settings (got ${describe(locked)})`
            );
            try {
                const refused = await patchSettings(asUser(member), { paused: true });
                expect(
                    refused.status === 403 && errorCodeOf(refused) === 'locked',
                    `a member's PATCH is refused as locked (got ${describe(refused)})`
                );
                const trigger = await sendAsUser(`/model@${BOT_USERNAME} deepseek-flash`);
                const notice = await waitForBotText(trigger, '本聊天的设置已被机主锁定');
                expect(Boolean(notice), '/model is refused while locked');
            } finally {
                await restoreSettings(asUser(SYNTHETIC_OWNER), { settingsLocked: false });
            }
        },
    },
];
