/**
 * GET /api/health: liveness without auth and without touching the database.
 */
import type { Hono } from 'hono';
import { modelCatalogVersion } from '../../config/model-catalog.js';
import { priceTableVersion } from '../../config/model-pricing.js';
import { isChatSettingsCacheLoaded } from '../../services/chat-settings-service.js';
import { countResumableReplies } from '../../state.js';
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
            // The in-memory price table the estimate uses; never read the DB here
            priceTableVersion: priceTableVersion(),
            // The in-memory catalog content hash; moves when capabilities change
            catalogVersion: modelCatalogVersion(),
            settingsLoaded: isChatSettingsCacheLoaded(),
            // Kept checkpoints live in memory: a restart drops them (design D3)
            resumableReplies: countResumableReplies(),
        })
    );
};
