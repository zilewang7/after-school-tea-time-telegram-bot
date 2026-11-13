/**
 * GET /api/model-catalog?includeDisabled=1: the owner's read-only view of the
 * model catalog (thinking-effort design 2026-1113-1742 §5).
 *
 * One row per catalog model with the normalized capabilities JSON the runtime
 * would read, plus where that row and its reasoning data came from, when they
 * were checked and with what confidence. `traitsOrigin` names what the runtime
 * actually resolves for the id right now (catalog row, code seed or fallback),
 * which is how the owner can tell "the data says X" from "the code still says
 * Y". Editing stays out of the panel: capability changes go through the private
 * approval buttons, so this route only reads.
 *
 * Owner only (requireOwner). Disabled rows are hidden by default: they left the
 * menu; `includeDisabled=1` shows them too, marked as disabled. No environment
 * value or secret is part of the answer — only catalog columns and the
 * normalized capabilities object.
 */
import type { Hono } from 'hono';
import { resolveModelTraits } from '../../ai/model-traits.js';
import { modelCatalogVersion, type ModelCatalogCapabilities } from '../../config/model-catalog.js';
import { countPendingCapabilityProposals } from '../../services/model-capability-service.js';
import { listCatalogRows } from '../../services/model-catalog-service.js';
import { requireAuth, requireOwner, type PanelEnv } from '../context.js';

/** Where the runtime resolves a model's traits from right now */
export type ModelTraitsOrigin = 'catalog' | 'seed' | 'code';

export interface ModelCatalogEntryView {
    readonly id: string;
    readonly label: string;
    /** The prefix routing's platform; null when the catalog row has none */
    readonly platform: string | null;
    readonly enabled: boolean;
    readonly source: string;
    /** YYYY-MM-DD the row was last checked */
    readonly checkedOn: string;
    readonly confidence: string;
    /** catalog = the row's capabilities drive the runtime; seed/code = fallback */
    readonly traitsOrigin: ModelTraitsOrigin;
    /** Normalized capabilities; the same object shape the runtime reads */
    readonly capabilities: ModelCatalogCapabilities;
}

export interface ModelCatalogResponse {
    /** The in-memory catalog content hash (same value /api/health reports) */
    readonly catalogVersion: string;
    /** Capability proposals waiting for the owner's approval */
    readonly pendingProposals: number;
    readonly models: readonly ModelCatalogEntryView[];
}

/** `1`/`true` shows retired rows too; anything else keeps the default (enabled only) */
const includeDisabledOf = (raw: string | undefined): boolean => raw === '1' || raw === 'true';

export const registerModelCatalogRoute = (app: Hono<PanelEnv>): void => {
    app.get('/api/model-catalog', async (context) => {
        const auth = requireAuth(context);
        requireOwner(auth);
        const includeDisabled = includeDisabledOf(context.req.query('includeDisabled'));
        // listCatalogRows reads every row; disabled ones are filtered below, so
        // the owner's default view stays the menu the bot offers
        const [rows, pendingProposals] = await Promise.all([
            listCatalogRows(),
            countPendingCapabilityProposals(),
        ]);
        const models: ModelCatalogEntryView[] = rows
            .filter((row) => includeDisabled || row.enabled)
            .map((row) => ({
                id: row.id,
                label: row.label,
                platform: row.platform ?? null,
                enabled: row.enabled,
                source: row.source,
                checkedOn: row.checkedOn,
                confidence: row.confidence,
                traitsOrigin: resolveModelTraits(row.id).origin,
                capabilities: row.capabilities,
            }));
        const response: ModelCatalogResponse = {
            catalogVersion: modelCatalogVersion(),
            pendingProposals,
            models,
        };
        return context.json(response);
    });
};
