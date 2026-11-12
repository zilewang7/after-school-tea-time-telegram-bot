/**
 * Body of PATCH /api/global: a partial update of `defaultModel` (string or
 * null) and `defaultGeminiPriority` (boolean), at least one of them. Unknown
 * keys and wrong types are 400s here; lengths and normalization are the
 * settings service's.
 */
import { match } from 'ts-pattern';
import { GLOBAL_SETTING_KEYS, type GlobalSettingsPatch } from '../../services/chat-settings-service.js';
import type { JsonRecord } from '../json.js';
import { checkBodyKeys, invalid } from '../request.js';

const ALLOWED_KEYS: ReadonlySet<string> = new Set<string>(GLOBAL_SETTING_KEYS);

/** The typed patch, every value checked before the service sees any of them */
export const toGlobalSettingsPatch = (body: JsonRecord): GlobalSettingsPatch => {
    checkBodyKeys(body, ALLOWED_KEYS, GLOBAL_SETTING_KEYS);
    const patch: GlobalSettingsPatch = {};
    for (const key of GLOBAL_SETTING_KEYS.filter((candidate) => Object.hasOwn(body, candidate))) {
        const value = body[key];
        match(key)
            .with('defaultModel', () => {
                if (typeof value !== 'string' && value !== null) throw invalid(`${key} 必须是字符串或 null`);
                patch.defaultModel = value;
            })
            .with('defaultGeminiPriority', () => {
                if (typeof value !== 'boolean') throw invalid(`${key} 必须是布尔值`);
                patch.defaultGeminiPriority = value;
            })
            .exhaustive();
    }
    return patch;
};
