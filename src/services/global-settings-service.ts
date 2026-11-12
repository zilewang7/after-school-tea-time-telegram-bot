/**
 * The only write path for the global settings (design §8.5), owner only: the
 * panel default model and the global Priority PayGo switch. Every key of a
 * patch is normalized first; then every row and its audit go in one
 * transaction, serialized with the other global writes, and the cache follows
 * the commit. So one bad key leaves the other unwritten.
 */
import { sequelize } from '../db/config.js';
import { withBusyRetry } from '../db/busy-retry.js';
import { GlobalSetting } from '../db/globalSettingDTO.js';
import { GLOBAL_AUDIT_SCOPE, writeSettingsAudit } from '../db/queries/settings-audit.js';
import {
    DEFAULT_GEMINI_PRIORITY_SETTING_KEY,
    DEFAULT_MODEL_SETTING_KEY,
    getGlobalDefaultModel,
    getStoredGlobalSetting,
    storeGlobalSetting,
} from './chat-settings-cache.js';
import {
    resolveGlobalSettingsPatch,
    type GlobalSettingChange,
    type GlobalSettingKey,
    type GlobalSettingsPatch,
} from './global-settings-rules.js';
import { ChatSettingsError, type SettingsActor } from './settings-errors.js';
import { ensureCacheLoaded, runSerialized } from './settings-write-queue.js';

export interface GlobalSettingsUpdateResult {
    /** Empty when every value already matched: nothing was written or audited */
    changedKeys: readonly GlobalSettingKey[];
}

/** The global_settings row (and audit key) each patch key is stored under */
const STORAGE_KEYS: Readonly<Record<GlobalSettingKey, string>> = {
    defaultModel: DEFAULT_MODEL_SETTING_KEY,
    defaultGeminiPriority: DEFAULT_GEMINI_PRIORITY_SETTING_KEY,
};

const persistGlobalSettings = async (changes: readonly GlobalSettingChange[], actorId: number): Promise<void> => {
    const updatedAt = new Date();
    await sequelize.transaction(async (transaction) => {
        for (const change of changes) {
            const key = STORAGE_KEYS[change.key];
            if (change.newValue === null) {
                await GlobalSetting.destroy({ where: { key }, transaction });
            } else {
                await GlobalSetting.upsert(
                    { key, value: change.newValue, updatedAt, updatedBy: actorId },
                    { transaction }
                );
            }
            await writeSettingsAudit(
                { actorId, scope: GLOBAL_AUDIT_SCOPE, key, oldValue: change.oldValue, newValue: change.newValue },
                { transaction }
            );
        }
    });
};

/** Decide, write and cache one patch; the caller holds the global write queue */
const applyGlobalSettingsPatch = async (
    patch: GlobalSettingsPatch,
    actor: SettingsActor
): Promise<GlobalSettingsUpdateResult> => {
    await ensureCacheLoaded();
    const resolution = resolveGlobalSettingsPatch(patch, {
        actorIsOwner: actor.isOwner,
        storedValueOf: (key) => getStoredGlobalSetting(STORAGE_KEYS[key]),
    });
    if (resolution.kind === 'rejected') {
        throw new ChatSettingsError(resolution.code, resolution.message);
    }
    if (resolution.changes.length === 0) return { changedKeys: [] };

    await withBusyRetry(() => persistGlobalSettings(resolution.changes, actor.userId), 'global settings');
    for (const change of resolution.changes) {
        storeGlobalSetting(STORAGE_KEYS[change.key], change.newValue);
    }
    return { changedKeys: resolution.changes.map((change) => change.key) };
};

/**
 * Change some of the global settings. Throws ChatSettingsError: `forbidden`
 * for a non-owner, `invalid` for a malformed value (nothing is written for
 * any key then). Unchanged keys are dropped; with nothing left, nothing is
 * written and changedKeys is empty.
 */
export const updateGlobalSettings = (
    patch: GlobalSettingsPatch,
    actor: SettingsActor
): Promise<GlobalSettingsUpdateResult> =>
    runSerialized(GLOBAL_AUDIT_SCOPE, () => applyGlobalSettingsPatch(patch, actor));

/**
 * Owner only. A model id sets the panel default; null removes it, so
 * DEFAULT_MODEL applies again. Returns the effective global default afterwards.
 * Setting the value it already has writes nothing.
 */
export const updateGlobalDefaultModel = (model: string | null, actor: SettingsActor): Promise<string> =>
    runSerialized(GLOBAL_AUDIT_SCOPE, async () => {
        await applyGlobalSettingsPatch({ defaultModel: model }, actor);
        return getGlobalDefaultModel();
    });
