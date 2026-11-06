/**
 * GET /api/health: liveness without auth and without touching the database.
 */
import type { Hono } from 'hono';
import { isChatSettingsCacheLoaded } from '../../services/chat-settings-service.js';
import type { PanelEnv } from '../context.js';

export interface HealthInfo {
    startedAt: Date;
    /** Short commit hash read at startup; null without git */
    version: string | null;
}

export const registerHealthRoute = (app: Hono<PanelEnv>, info: HealthInfo): void => {
    app.get('/api/health', (context) =>
        context.json({
            ok: true,
            startedAt: info.startedAt.toISOString(),
            version: info.version,
            settingsLoaded: isChatSettingsCacheLoaded(),
        })
    );
};
