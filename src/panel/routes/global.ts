/**
 * GET / PATCH /api/global: the global default model, owner only. PATCH takes
 * `{ defaultModel: string | null }`; null removes the panel value so
 * DEFAULT_MODEL applies again.
 */
import type { Hono } from 'hono';
import {
    getGlobalDefaultModel,
    getGlobalDefaultModelSource,
    updateGlobalDefaultModel,
} from '../../services/chat-settings-service.js';
import { requireAuth, requireOwner, type PanelEnv } from '../context.js';
import { checkBodyKeys, invalid, readJsonObject } from '../request.js';
import { rethrowSettingsError } from './settings-errors.js';

const DEFAULT_MODEL_KEY = 'defaultModel';
const ALLOWED_KEYS: ReadonlySet<string> = new Set([DEFAULT_MODEL_KEY]);

const globalSettingsView = () => ({
    defaultModel: getGlobalDefaultModel(),
    source: getGlobalDefaultModelSource(),
});

export const registerGlobalRoutes = (app: Hono<PanelEnv>): void => {
    app.get('/api/global', (context) => {
        requireOwner(requireAuth(context));
        return context.json(globalSettingsView());
    });

    app.patch('/api/global', async (context) => {
        const auth = requireAuth(context);
        requireOwner(auth);
        const body = await readJsonObject(context);
        checkBodyKeys(body, ALLOWED_KEYS, [DEFAULT_MODEL_KEY]);
        const value = body[DEFAULT_MODEL_KEY];
        if (typeof value !== 'string' && value !== null) throw invalid('defaultModel 必须是字符串或 null');

        await updateGlobalDefaultModel(value, { userId: auth.user.id, isOwner: auth.user.isOwner }).catch(
            rethrowSettingsError
        );
        return context.json(globalSettingsView());
    });
};
