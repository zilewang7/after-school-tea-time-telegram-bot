/**
 * PATCH /api/chats/:chatId/settings.
 *
 * Order (design §7): access (403 / 503) → body shape (400) → locked chat and
 * non-owner (403 locked, before any value is looked at) → non-owner touching
 * the lock (403 forbidden) → value types (400) → the settings service
 * (lengths and normalization 400, the owner-only sms and Priority PayGo
 * switches 403, Priority PayGo "on" where it cannot take effect 403, a trial
 * user changing the model or the thinking level 403 trial, then
 * expectedUpdatedAt 409 inside its write queue). Unchanged values answer 200
 * and write nothing.
 */
import type { Hono } from 'hono';
import {
    isChatSettingsLocked,
    updateChatSettings,
} from '../../services/chat-settings-service.js';
import { requireChatAccess } from '../access/require-access.js';
import { requireAuth, type PanelEnv, type RequestAuth } from '../context.js';
import { PanelError } from '../errors.js';
import { parseChatId, readJsonObject } from '../request.js';
import { toSettingsView } from '../views/chat-view.js';
import { parseSettingsPatchShape, toChatSettingsPatch, type SettingsPatchShape } from './settings-body.js';
import { rethrowSettingsError } from './settings-errors.js';

/** The two owner checks, ahead of value validation (the service repeats them under its lock) */
const checkOwnerRules = (auth: RequestAuth, chatId: number, shape: SettingsPatchShape): void => {
    if (auth.user.isOwner) return;
    if (isChatSettingsLocked(chatId)) throw new PanelError('locked', '本聊天的设置已被机主锁定');
    if (shape.keys.includes('settingsLocked')) {
        throw new PanelError('forbidden', '只有机主可以锁定或解锁本聊天的设置');
    }
};

export const registerChatSettingsRoute = (app: Hono<PanelEnv>): void => {
    app.patch('/api/chats/:chatId/settings', async (context) => {
        const auth = requireAuth(context);
        const chatId = parseChatId(context.req.param('chatId'));
        await requireChatAccess(auth, chatId);

        const body = await readJsonObject(context);
        const shape = parseSettingsPatchShape(body);
        checkOwnerRules(auth, chatId, shape);
        const patch = toChatSettingsPatch(body, shape);

        const result = await updateChatSettings({
            chatId,
            patch,
            actor: { userId: auth.user.id, isOwner: auth.user.isOwner },
            expectedUpdatedAt: shape.expectedUpdatedAt,
        }).catch(rethrowSettingsError);
        return context.json({ settings: toSettingsView(result.settings) });
    });
};
