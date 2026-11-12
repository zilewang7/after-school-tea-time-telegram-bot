/**
 * GET / PATCH /api/global: the global settings, owner only. PATCH is a partial
 * update of `{ defaultModel?: string | null, defaultGeminiPriority?: boolean }`
 * with at least one key; null removes the panel model so DEFAULT_MODEL applies
 * again. Every key is checked before any is written, and the keys present are
 * written together or not at all (design §8.5).
 */
import type { Hono } from 'hono';
import {
    getGlobalDefaultModel,
    getGlobalDefaultModelSource,
    getGlobalGeminiPriority,
    updateGlobalSettings,
} from '../../services/chat-settings-service.js';
import { requireAuth, requireOwner, type PanelEnv } from '../context.js';
import { readJsonObject } from '../request.js';
import { toGlobalSettingsPatch } from './global-body.js';
import { rethrowSettingsError } from './settings-errors.js';

export interface GlobalSettingsView {
    /** The effective default model */
    defaultModel: string;
    /** Where it comes from: the panel's value, or DEFAULT_MODEL */
    source: 'panel' | 'env';
    /** The global Priority PayGo switch; off unless the owner turned it on */
    defaultGeminiPriority: boolean;
}

const globalSettingsView = (): GlobalSettingsView => ({
    defaultModel: getGlobalDefaultModel(),
    source: getGlobalDefaultModelSource(),
    defaultGeminiPriority: getGlobalGeminiPriority(),
});

export const registerGlobalRoutes = (app: Hono<PanelEnv>): void => {
    app.get('/api/global', (context) => {
        requireOwner(requireAuth(context));
        return context.json(globalSettingsView());
    });

    app.patch('/api/global', async (context) => {
        const auth = requireAuth(context);
        requireOwner(auth);
        const patch = toGlobalSettingsPatch(await readJsonObject(context));

        await updateGlobalSettings(patch, { userId: auth.user.id, isOwner: auth.user.isOwner }).catch(
            rethrowSettingsError
        );
        return context.json(globalSettingsView());
    });
};
