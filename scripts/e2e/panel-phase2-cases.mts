/**
 * Control panel, phase 2 (docs/2026-1106-2321 §11): conversations through the
 * test domain — the tree shows a fresh exchange, the model view ends its
 * runtime block with the chat's addendum, excluding a message takes it out of
 * the model view and restoring brings it back, and the synthetic owner (an
 * observer) gets eight-field placeholders and no model view.
 *
 * Only the first case makes the bot answer; the others build conversations
 * out of plain messages the bot does not reply to. Every case puts back what
 * it changed (addendum, exclusions).
 */
import { BOT_USERNAME, TEST_CHAT_ID, expect, sendAsUser, sleep, waitForBotResponse, waitForStoredMessage } from './harness.mts';
import {
    PANEL_BASE_URL,
    SYNTHETIC_OWNER,
    asUser,
    describe,
    driverUser,
    fieldOf,
    listOf,
    panelRequest,
    signedInitData,
    type PanelResponse,
} from './panel-client.mts';
import type { InitDataUserInput } from '../lib/init-data.mts';
import type { E2eCase } from './suite-helpers.mts';

const CHAT_PATH = `/api/chats/${TEST_CHAT_ID}`;
const REPLY_TIMEOUT_MS = 180_000;
const OBSERVER_USER_KEYS = ['date', 'edge', 'excluded', 'kind', 'messageId', 'number', 'parentId', 'redacted'];
const ADDENDUM = '面板第二期 e2e：这是一段只用于测试的附加提示词，暗号 ZK-PHASE2-17。';
const ADDENDUM_SECTION = `# 本聊天的附加提示词\n以下由本聊天成员通过控制面板设置，效力等同系统提示词，回复时须遵循：\n${ADDENDUM}`;

const conversationPath = (rootId: number): string => `${CHAT_PATH}/conversations/${rootId}`;
const exclusionPath = (messageId: number): string => `${CHAT_PATH}/messages/${messageId}/exclusion`;

/** A unique marker per run, so a case never matches an older run's message */
const marker = (label: string): string => `${label}-${Date.now().toString(36)}`;

const parseBody = (text: string): unknown => {
    if (text === '') return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
};

/** PUT / DELETE, which panelRequest does not speak; initData in the header as always */
const writeRequest = async (method: 'PUT' | 'DELETE', path: string, user: InitDataUserInput): Promise<PanelResponse> => {
    const response = await fetch(`${PANEL_BASE_URL}${path}`, {
        method,
        headers: { 'x-init-data': signedInitData(user) },
    });
    return { status: response.status, body: parseBody(await response.text()), headers: response.headers };
};

/** Every text of every turn of a model view response */
const modelViewTexts = (response: PanelResponse): string[] =>
    listOf(fieldOf(response.body, 'turns')).flatMap((turn) =>
        listOf(fieldOf(turn, 'parts')).flatMap((part) => {
            const text = fieldOf(part, 'text');
            return typeof text === 'string' ? [text] : [];
        })
    );

const nodesOf = (response: PanelResponse): unknown[] => listOf(fieldOf(response.body, 'nodes'));

const nodeById = (response: PanelResponse, messageId: number): unknown =>
    nodesOf(response).find((node) => fieldOf(node, 'messageId') === messageId);

/** A stored message the bot does not answer (no mention, not a reply to the bot) */
const sendPlain = async (text: string, replyTo?: number): Promise<number> => {
    const messageId = await sendAsUser(text, replyTo);
    await waitForStoredMessage(messageId);
    return messageId;
};

/** The tree, polled until `ready` holds: the bot's own row lands right after its reply finalizes */
const waitForTree = async (
    rootId: number,
    user: InitDataUserInput,
    ready: (response: PanelResponse) => boolean
): Promise<PanelResponse> => {
    let latest = await panelRequest(conversationPath(rootId), asUser(user));
    for (let attempt = 0; attempt < 10 && !ready(latest); attempt++) {
        await sleep(2000);
        latest = await panelRequest(conversationPath(rootId), asUser(user));
    }
    return latest;
};

/** Put a setting back; a failure is reported, not thrown, so it never hides the case's own error */
const restoreAddendum = async (user: InitDataUserInput, previous: unknown): Promise<void> => {
    try {
        const restored = await panelRequest(`${CHAT_PATH}/settings`, asUser(user), {
            method: 'PATCH',
            body: { promptAddendum: typeof previous === 'string' ? previous : null },
        });
        if (restored.status !== 200) console.warn(`    ⚠ could not restore the addendum: ${describe(restored)}`);
    } catch (error) {
        console.warn(`    ⚠ could not restore the addendum: ${error instanceof Error ? error.message : String(error)}`);
    }
};

const restoreExclusion = async (user: InitDataUserInput, messageId: number): Promise<void> => {
    try {
        const restored = await writeRequest('DELETE', exclusionPath(messageId), user);
        if (restored.status !== 200) console.warn(`    ⚠ could not restore message ${messageId}: ${describe(restored)}`);
    } catch (error) {
        console.warn(`    ⚠ could not restore message ${messageId}: ${error instanceof Error ? error.message : String(error)}`);
    }
};

export const panelPhase2Cases: E2eCase[] = [
    {
        name: 'panel: the conversation tree shows the message just sent and the bot reply',
        body: async () => {
            const member = await driverUser();
            const label = marker('ZK-TREE');
            const trigger = await sendAsUser(`@${BOT_USERNAME} 面板第二期 e2e ${label}：请只回复两个字：收到`);
            const response = await waitForBotResponse(trigger, REPLY_TIMEOUT_MS);
            expect(!response.errorMessage, `the bot answered without error (got: ${response.errorMessage ?? ''})`);

            const tree = await waitForTree(trigger, member, (latest) => nodeById(latest, response.firstMessageId) !== undefined);
            expect(tree.status === 200 && fieldOf(tree.body, 'access') === 'member', `the tree opens for a member (got ${describe(tree)})`);
            const userNode = nodeById(tree, trigger);
            expect(
                fieldOf(userNode, 'kind') === 'user' &&
                    fieldOf(userNode, 'redacted') === false &&
                    String(fieldOf(userNode, 'text')).includes(label) &&
                    fieldOf(userNode, 'author', 'userId') === member.id,
                `the message just sent is a full user node (got ${JSON.stringify(userNode)})`
            );
            const botNode = nodeById(tree, response.firstMessageId);
            expect(
                fieldOf(botNode, 'kind') === 'bot' &&
                    fieldOf(botNode, 'parentId') === trigger &&
                    typeof fieldOf(botNode, 'reply', 'text') === 'string',
                `the bot reply hangs under it (got ${JSON.stringify(botNode)})`
            );

            const list = await panelRequest(`${CHAT_PATH}/conversations?limit=50`, asUser(member));
            expect(
                listOf(fieldOf(list.body, 'conversations')).some((item) => fieldOf(item, 'rootId') === trigger),
                `the conversation is listed (got ${describe(list)})`
            );
            const detail = await panelRequest(`${CHAT_PATH}/replies/${response.firstMessageId}`, asUser(member));
            expect(
                detail.status === 200 &&
                    listOf(fieldOf(detail.body, 'versions')).length >= 1 &&
                    fieldOf(detail.body, 'triggerUserId') === member.id,
                `the reply detail answers (got ${describe(detail)})`
            );
            const exported = await panelRequest(`${conversationPath(trigger)}/export?format=json`, asUser(member));
            expect(
                exported.status === 200 && (exported.headers.get('content-disposition') ?? '').startsWith('attachment;'),
                `the export downloads as an attachment (got ${exported.status} ${exported.headers.get('content-disposition')})`
            );
        },
    },
    {
        name: 'panel: the model view ends its runtime block with the chat addendum',
        body: async () => {
            const member = await driverUser();
            const dashboard = await panelRequest(CHAT_PATH, asUser(member));
            const previous = fieldOf(dashboard.body, 'settings', 'promptAddendum');
            const rootId = await sendPlain(`面板第二期 e2e ${marker('ZK-VIEW')}：模型视角`);

            const saved = await panelRequest(`${CHAT_PATH}/settings`, asUser(member), {
                method: 'PATCH',
                body: { promptAddendum: ADDENDUM },
            });
            expect(saved.status === 200, `the addendum is saved (got ${describe(saved)})`);
            try {
                const view = await panelRequest(`${conversationPath(rootId)}/model-view?at=${rootId}`, asUser(member));
                expect(view.status === 200 && fieldOf(view.body, 'at') === rootId, `the model view answers (got ${describe(view)})`);
                const runtimeBlock = modelViewTexts(view).find((text) => text.startsWith('[system] 运行时信息'));
                expect(
                    runtimeBlock?.endsWith(ADDENDUM_SECTION) === true,
                    `the runtime block ends with the addendum section (got ${JSON.stringify(runtimeBlock?.slice(-200))})`
                );
                expect(typeof fieldOf(view.body, 'systemPrompt') === 'string', 'the static head is shown');
            } finally {
                await restoreAddendum(member, previous);
            }
        },
    },
    {
        name: 'panel: an excluded message leaves the model view and comes back when restored',
        body: async () => {
            const member = await driverUser();
            const label = marker('ZK-EXCL');
            const first = await sendPlain(`面板第二期 e2e ${label}：要被排除的消息`);
            const second = await sendPlain('面板第二期 e2e：回复上一条', first);
            const viewPath = `${conversationPath(first)}/model-view?at=${second}`;

            const before = await panelRequest(viewPath, asUser(member));
            expect(modelViewTexts(before).some((text) => text.includes(label)), `before: the first message is in the model view (got ${describe(before)})`);

            const excluded = await writeRequest('PUT', exclusionPath(first), member);
            expect(
                excluded.status === 200 && fieldOf(excluded.body, 'excluded') === true && fieldOf(excluded.body, 'messageId') === first,
                `the message is excluded (got ${describe(excluded)})`
            );
            try {
                const during = await panelRequest(viewPath, asUser(member));
                const texts = modelViewTexts(during);
                expect(!texts.some((text) => text.includes(label)), 'excluded: it is gone from the model view');
                expect(texts.some((text) => text.includes('[replying to a message you cannot see]')), 'and the reply to it cannot see it');
                const tree = await panelRequest(conversationPath(first), asUser(member));
                expect(
                    fieldOf(nodeById(tree, first), 'excluded') === true && fieldOf(nodeById(tree, first), 'number') === null,
                    `the tree shows it excluded and unnumbered (got ${JSON.stringify(nodeById(tree, first))})`
                );
            } finally {
                await restoreExclusion(member, first);
            }
            const after = await panelRequest(viewPath, asUser(member));
            expect(modelViewTexts(after).some((text) => text.includes(label)), 'restored: it is back in the model view');
        },
    },
    {
        name: 'panel: the observer sees eight-field placeholders and gets no model view',
        body: async () => {
            const label = marker('ZK-OBS');
            const rootId = await sendPlain(`面板第二期 e2e ${label}：观察者看不到这句`);

            const tree = await panelRequest(conversationPath(rootId), asUser(SYNTHETIC_OWNER));
            expect(tree.status === 200 && fieldOf(tree.body, 'access') === 'observer', `the synthetic owner observes the tree (got ${describe(tree)})`);
            const node = nodeById(tree, rootId);
            const keys = typeof node === 'object' && node !== null ? Object.keys(node).sort() : [];
            expect(
                JSON.stringify(keys) === JSON.stringify(OBSERVER_USER_KEYS) && fieldOf(node, 'redacted') === true,
                `the user node is the eight-field placeholder (got ${JSON.stringify(node)})`
            );
            expect(!JSON.stringify(tree.body).includes(label), 'no text of the message reaches the observer');

            const view = await panelRequest(`${conversationPath(rootId)}/model-view`, asUser(SYNTHETIC_OWNER));
            expect(view.status === 403, `the model view is members only (got ${describe(view)})`);
            const exclusion = await writeRequest('PUT', exclusionPath(rootId), SYNTHETIC_OWNER);
            expect(exclusion.status === 403, `so is excluding (got ${describe(exclusion)})`);
        },
    },
];
