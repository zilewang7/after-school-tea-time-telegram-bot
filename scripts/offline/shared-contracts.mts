/**
 * Offline cases for Move 1 (L0 public-url / L2 chat-model) and Move 2
 * (single-source-of-truth shared contracts under `src/shared/contracts/`):
 *
 * - `tool-groups`: canonical keys, order, labels, hints, guard, and alignment
 *   between backend (`services/tool-overrides`) and frontend (`webapp/src/tool-groups`).
 * - `thinking-effort`: graded order, closed values, labels, normalization, and
 *   alignment with `config/model-capabilities` and `services/thinking-effort-values`.
 * - `chat-settings`: canonical keys, labels, guard, and alignment with
 *   `services/chat-settings-rules` and `panel/routes/settings-body`.
 * - `start-param`: encode/decode round-trip across all six target kinds,
 *   malformed inputs, and direct-link URL builders.
 * - `public-url` & `config/web-login`: env-driven panel and Mini App URLs.
 * - `services/chat-model`: `resolveChatModel` fallback chain.
 *
 * Run: npx tsx scripts/offline/shared-contracts.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';

process.env.DEFAULT_MODEL = 'contracts-env-default';

await setupOfflineDb();

const contracts = await import('../../src/shared/contracts/index.js');
const publicUrl = await import('../../src/shared/public-url.js');
const webLogin = await import('../../src/config/web-login.js');
const chatModel = await import('../../src/services/chat-model.js');
const chatSettingsService = await import('../../src/services/chat-settings-service.js');
const toolOverrides = await import('../../src/services/tool-overrides.js');
const thinkingValues = await import('../../src/services/thinking-effort-values.js');
const modelCapabilities = await import('../../src/config/model-capabilities.js');
const chatSettingsRules = await import('../../src/services/chat-settings-rules.js');
const settingsBody = await import('../../src/panel/routes/settings-body.js');
const panelStartParam = await import('../../src/panel/auth/start-param.js');
const shareUrls = await import('../../src/panel/share/share-urls.js');
const thinkingUrls = await import('../../src/panel/thinking/thinking-urls.js');
const miniAppLink = await import('../../src/cmd/commands/mini-app-link.js');
const widgetLinkFallback = await import('../../src/reply/widget-link-fallback.js');
const issueNotify = await import('../../src/services/harness-issue-notify.js');
const webappToolGroups = await import('../../webapp/src/tool-groups.ts');

type StartParamTarget = import('../../src/shared/contracts/index.js').StartParamTarget;

const withEnv = (patch: Record<string, string | undefined>, fn: () => void): void => {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(patch)) {
        previous.set(key, process.env[key]);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        fn();
    } finally {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
};

const results: CaseResult[] = [];

results.push(
    await runCase('tool-groups contract is exhaustive and shared across backend and webapp', () => {
        expect(contracts.TOOL_GROUP_KEYS.length > 0, 'keys list is non-empty');
        expect(contracts.TOOL_GROUP_ORDER === contracts.TOOL_GROUP_KEYS, 'order aliases canonical keys');
        expect(toolOverrides.TOOL_GROUP_KEYS === contracts.TOOL_GROUP_KEYS, 'backend shares TOOL_GROUP_KEYS');
        expect(webappToolGroups.TOOL_GROUP_KEYS === contracts.TOOL_GROUP_KEYS, 'webapp shares TOOL_GROUP_KEYS');
        expect(webappToolGroups.TOOL_GROUP_ORDER === contracts.TOOL_GROUP_ORDER, 'webapp shares TOOL_GROUP_ORDER');

        for (const key of contracts.TOOL_GROUP_KEYS) {
            expect(contracts.isToolGroupKey(key), `${key} passes guard`);
            expect(contracts.TOOL_GROUP_LABELS[key].trim().length > 0, `${key} has a non-empty label`);
            expect(contracts.TOOL_GROUP_HINTS[key].trim().length > 0, `${key} has a non-empty hint`);
            expect(webappToolGroups.toolGroupLabelOf(key) === contracts.TOOL_GROUP_LABELS[key], `${key} label matches`);
            expect(webappToolGroups.toolGroupHintOf(key) === contracts.TOOL_GROUP_HINTS[key], `${key} hint matches`);
        }
        expect(!contracts.isToolGroupKey('nonexistent_group'), 'unknown key fails guard');
    })
);

results.push(
    await runCase('thinking-effort contract aligns model-capabilities and thinking-effort-values', () => {
        expect(modelCapabilities.MODEL_EFFORTS === contracts.THINKING_EFFORT_ORDER, 'MODEL_EFFORTS shares order');
        expect(thinkingValues.THINKING_EFFORT_VALUES === contracts.THINKING_EFFORT_VALUES, 'backend shares values');
        expect(thinkingValues.THINKING_EFFORT_LABELS === contracts.THINKING_EFFORT_LABELS, 'backend shares labels');
        expect(contracts.THINKING_EFFORT_OFF === 'off', 'off constant is off');
        expect(
            contracts.THINKING_EFFORT_OFF_LABEL === contracts.THINKING_EFFORT_LABELS.off,
            'off label comes from labels map'
        );

        for (const value of contracts.THINKING_EFFORT_VALUES) {
            expect(contracts.isThinkingEffort(value), `${value} passes guard`);
            expect(contracts.thinkingEffortLabel(value) === contracts.THINKING_EFFORT_LABELS[value], `${value} label`);
            const normalized = contracts.normalizeThinkingEffort(value);
            expect(normalized.ok && normalized.value === value, `${value} normalizes cleanly`);
        }
        const nullNormalized = contracts.normalizeThinkingEffort(null);
        expect(nullNormalized.ok && nullNormalized.value === null, 'null normalizes to null');
        expect(!contracts.normalizeThinkingEffort('turbo').ok, 'unknown string is rejected');
        expect(!contracts.normalizeThinkingEffort(42).ok, 'non-string is rejected');
        expect(contracts.thinkingEffortLabel('turbo') === 'turbo', 'unknown display label falls back to raw value');
    })
);

results.push(
    await runCase('chat-settings contract aligns rules and PATCH body parser', () => {
        expect(chatSettingsRules.CHAT_SETTING_KEYS === contracts.CHAT_SETTING_KEYS, 'rules share CHAT_SETTING_KEYS');
        for (const key of contracts.CHAT_SETTING_KEYS) {
            expect(contracts.isChatSettingKey(key), `${key} passes guard`);
            expect(contracts.CHAT_SETTING_LABELS[key].trim().length > 0, `${key} has a non-empty label`);
        }
        expect(!contracts.isChatSettingKey('unknownKey'), 'unknown key fails guard');

        const body: Record<string, unknown> = {};
        for (const key of contracts.CHAT_SETTING_KEYS) body[key] = null;
        const shape = settingsBody.parseSettingsPatchShape(body);
        expect(
            JSON.stringify(shape.keys) === JSON.stringify(contracts.CHAT_SETTING_KEYS),
            'PATCH parser accepts every canonical key in canonical order'
        );
    })
);

results.push(
    await runCase('start-param codec round-trips every target kind and rejects malformed input', () => {
        const token = 'AbCdEfGhIjKlMnOpQrStUvWx';
        const targets: readonly StartParamTarget[] = [
            { kind: 'chat', chatId: -1001234567890 },
            { kind: 'chat', chatId: 4242 },
            { kind: 'conversation', chatId: -1001234567890, rootId: 987 },
            { kind: 'issue', issueId: 42 },
            { kind: 'reply', chatId: -1001234567890, firstMessageId: 1234 },
            { kind: 'share', token },
            { kind: 'thinking', token },
        ];
        for (const target of targets) {
            const encoded = contracts.encodeStartParam(target);
            const decoded = contracts.decodeStartParam(encoded);
            expect(
                JSON.stringify(decoded) === JSON.stringify(target),
                `${target.kind} round-trips via "${encoded}"`
            );
            expect(
                JSON.stringify(panelStartParam.parseStartParam(encoded)) === JSON.stringify(target),
                `panel parseStartParam matches for "${encoded}"`
            );
        }

        expect(contracts.isStartParamToken(token), 'valid base64url token accepted');
        expect(!contracts.isStartParamToken('short'), 'short token rejected');
        expect(!contracts.isStartParamToken('bad!token_1234567890'), 'invalid char rejected');
        for (const bad of ['', null, undefined, 'c0', 'c1_0', 'r0_5', 's123', 't123', 'x42']) {
            expect(contracts.decodeStartParam(bad) === null, `malformed "${String(bad)}" returns null`);
        }
    })
);

results.push(
    await runCase('public-url, web-login, and Direct Link builders agree on env URLs', () => {
        const token = 'AbCdEfGhIjKlMnOpQrStUvWx';
        withEnv(
            {
                WEBAPP_PUBLIC_URL: 'https://panel.example.com///',
                BOT_USER_NAME: 'TestBot',
                WEBAPP_BOT_SHORT_NAME: 'app',
                WEB_LOGIN: '1',
            },
            () => {
                expect(publicUrl.webappPublicUrl() === 'https://panel.example.com', 'trailing slashes trimmed');
                expect(webLogin.webLoginPublicUrl() === 'https://panel.example.com', 'webLoginPublicUrl matches');
                expect(webLogin.webLoginSecureCookies(), 'https enables secure cookies');
                expect(publicUrl.miniAppShortName() === 'app', 'custom short name read');
                expect(publicUrl.miniAppPanelLink() === 'https://t.me/TestBot/app', 'panel link');
                expect(shareUrls.miniAppPanelLink() === 'https://t.me/TestBot/app', 'share-urls re-export matches');
                expect(webLogin.webLoginMiniAppLink() === 'https://t.me/TestBot/app', 'web-login uses shared helper');
                expect(webLogin.webLoginBotChatLink() === 'https://t.me/TestBot', 'bot chat link');
                expect(
                    publicUrl.miniAppDirectLink('c-100') === 'https://t.me/TestBot/app?startapp=c-100',
                    'direct link with startapp'
                );
                expect(
                    miniAppLink.miniAppDirectLink('c-100') === 'https://t.me/TestBot/app?startapp=c-100',
                    'cmd miniAppDirectLink shares implementation'
                );
                expect(
                    shareUrls.miniAppShareLink(token) === `https://t.me/TestBot/app?startapp=s${token}`,
                    'share link uses codec'
                );
                expect(
                    thinkingUrls.thinkingMiniAppDeepLink(token) === `https://t.me/TestBot/app?startapp=t${token}`,
                    'thinking link uses codec'
                );
                expect(
                    issueNotify.issuePanelLink(7) === 'https://t.me/TestBot/app?startapp=i7',
                    'issue link uses codec'
                );
                expect(
                    widgetLinkFallback.miniAppReplyLink({
                        botUsername: 'TestBot',
                        shortName: 'app',
                        chatId: -1001,
                        firstMessageId: 55,
                    }) === 'https://t.me/TestBot/app?startapp=r-1001_55',
                    'widget reply link uses codec'
                );
            }
        );

        withEnv(
            {
                WEBAPP_PUBLIC_URL: 'http://localhost:3000',
                BOT_USER_NAME: '',
                WEBAPP_BOT_SHORT_NAME: '',
                WEB_LOGIN: '0',
            },
            () => {
                expect(!webLogin.webLoginEnabled(), 'WEB_LOGIN=0 disables web login');
                expect(!webLogin.webLoginSecureCookies(), 'http drops Secure cookie flag');
                expect(publicUrl.miniAppShortName() === 'panel', 'unset short name defaults to panel');
                expect(publicUrl.miniAppPanelLink() === null, 'missing bot username returns null');
                expect(webLogin.webLoginMiniAppLink() === null, 'webLoginMiniAppLink returns null');
                expect(webLogin.webLoginBotChatLink() === null, 'webLoginBotChatLink returns null');
            }
        );
    })
);

results.push(
    await runCase('services/chat-model resolves chat override -> global default -> env default', async () => {
        await chatSettingsService.loadChatSettingsCache();
        const chatId = -99001122;
        expect(chatModel.resolveChatModel(chatId) === 'contracts-env-default', 'falls back to env default');

        await chatSettingsService.updateGlobalDefaultModel('global-contract-model', { userId: 1, isOwner: true });
        expect(chatModel.resolveChatModel(chatId) === 'global-contract-model', 'falls back to global setting');

        await chatSettingsService.updateChatSettings({
            chatId,
            patch: { model: 'chat-specific-model' },
            actor: { userId: 1, isOwner: true },
        });
        expect(chatModel.resolveChatModel(chatId) === 'chat-specific-model', 'chat setting wins');

        await chatSettingsService.updateChatSettings({
            chatId,
            patch: { model: null },
            actor: { userId: 1, isOwner: true },
        });
        expect(chatModel.resolveChatModel(chatId) === 'global-contract-model', 'clearing chat setting restores global');
    })
);

reportResults(results);
