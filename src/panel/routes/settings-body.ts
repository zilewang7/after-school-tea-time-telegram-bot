/**
 * Body of PATCH /api/chats/:chatId/settings, checked in two steps so the
 * documented order holds: the shape first (unknown keys, no known key, a bad
 * expectedUpdatedAt), then — after the lock and owner checks — the value
 * types. Lengths and normalization are the settings service's.
 */
import { match } from 'ts-pattern';
import {
    normalizeNullableFlag,
    type ChatSettingKey,
    type ChatSettingsPatch,
} from '../../services/chat-settings-service.js';
import { normalizeToolOverrides } from '../../services/tool-overrides.js';
import type { JsonRecord } from '../json.js';
import { checkBodyKeys, invalid } from '../request.js';

const SETTING_KEYS: readonly ChatSettingKey[] = ['model', 'promptAddendum', 'paused', 'settingsLocked', 'toolOverrides'];
const EXPECTED_UPDATED_AT_KEY = 'expectedUpdatedAt';
const ALLOWED_KEYS: ReadonlySet<string> = new Set<string>([...SETTING_KEYS, EXPECTED_UPDATED_AT_KEY]);

export interface SettingsPatchShape {
    /** The setting keys present, in the service's order */
    keys: readonly ChatSettingKey[];
    /** When the client last saw the settings; null when not sent */
    expectedUpdatedAt: Date | null;
}

const parseExpectedUpdatedAt = (value: unknown): Date | null => {
    if (value === undefined) return null;
    if (typeof value !== 'string') throw invalid('expectedUpdatedAt 必须是 ISO 时间字符串');
    const time = Date.parse(value);
    if (Number.isNaN(time)) throw invalid('expectedUpdatedAt 必须是 ISO 时间字符串');
    return new Date(time);
};

export const parseSettingsPatchShape = (body: JsonRecord): SettingsPatchShape => {
    checkBodyKeys(body, ALLOWED_KEYS, SETTING_KEYS);
    return {
        keys: SETTING_KEYS.filter((key) => Object.hasOwn(body, key)),
        expectedUpdatedAt: parseExpectedUpdatedAt(body[EXPECTED_UPDATED_AT_KEY]),
    };
};

const stringOrNull = (value: unknown, key: string): string | null => {
    if (typeof value === 'string' || value === null) return value;
    throw invalid(`${key} 必须是字符串或 null`);
};

const booleanValue = (value: unknown, key: string): boolean => {
    if (typeof value === 'boolean') return value;
    throw invalid(`${key} 必须是布尔值`);
};

/** The typed patch; a value of the wrong type is a 400 */
export const toChatSettingsPatch = (body: JsonRecord, shape: SettingsPatchShape): ChatSettingsPatch => {
    const patch: ChatSettingsPatch = {};
    for (const key of shape.keys) {
        const value = body[key];
        match(key)
            .with('model', () => {
                patch.model = stringOrNull(value, key);
            })
            .with('promptAddendum', () => {
                patch.promptAddendum = stringOrNull(value, key);
            })
            .with('paused', () => {
                patch.paused = booleanValue(value, key);
            })
            .with('settingsLocked', () => {
                patch.settingsLocked = booleanValue(value, key);
            })
            .with('toolOverrides', () => {
                // Unknown group keys and non-boolean values are 400s here, before the service
                const normalized = normalizeToolOverrides(value);
                if (!normalized.ok) throw invalid(normalized.message);
                patch.toolOverrides = normalized.value;
            })
            .with('geminiPriority', () => {
                const normalized = normalizeNullableFlag(value, key);
                if (!normalized.ok) throw invalid(normalized.message);
                patch.geminiPriority = normalized.value;
            })
            .exhaustive();
    }
    return patch;
};
