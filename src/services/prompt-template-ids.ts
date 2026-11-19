/**
 * The chat setting's manually enabled prompt-template ids: normalization for
 * the write path, the canonical JSON stored in chat_settings and compared in
 * the audit, and the parser for a stored value.
 *
 * The list is normalized to ascending unique ids because the stored text and
 * the audit row are compared as text. An unknown id is kept: the composer
 * skips a template that was deleted, so restoring the row restores the enable.
 */

/** A chat may manually enable at most this many templates (design D8) */
export const MAX_TEMPLATE_SELECTIONS = 10;

export type TemplateIdListNormalization =
    | { readonly ok: true; readonly value: number[] | null }
    | { readonly ok: false; readonly message: string };

/** The panel text; a bad shape and an oversized list read the same to a user */
const INVALID_TEMPLATE_ID_LIST: TemplateIdListNormalization = {
    ok: false,
    message: `模板启用列表必须是模板 id 的数组或 null（最多 ${MAX_TEMPLATE_SELECTIONS} 个）`,
};

/**
 * null, or positive integer ids deduplicated and sorted ascending; an empty
 * list (or one that is empty after deduplication) means none.
 */
export const normalizeTemplateIdList = (raw: unknown): TemplateIdListNormalization => {
    if (raw === null) return { ok: true, value: null };
    if (!Array.isArray(raw)) return INVALID_TEMPLATE_ID_LIST;
    const ids = new Set<number>();
    for (const entry of raw) {
        if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry <= 0) {
            return INVALID_TEMPLATE_ID_LIST;
        }
        ids.add(entry);
    }
    if (ids.size === 0) return { ok: true, value: null };
    if (ids.size > MAX_TEMPLATE_SELECTIONS) return INVALID_TEMPLATE_ID_LIST;
    return { ok: true, value: [...ids].sort((left, right) => left - right) };
};

/** The stored and audit form: canonical JSON, or NULL for "no templates" */
export const canonicalTemplateIdListJson = (list: readonly number[] | null): string | null =>
    list === null ? null : JSON.stringify(list);

export const templateIdListEqual = (
    left: readonly number[] | null,
    right: readonly number[] | null
): boolean => canonicalTemplateIdListJson(left) === canonicalTemplateIdListJson(right);

/**
 * A stored value read back. Only the settings service writes the column, so bad
 * JSON or a bad shape means a hand-edited database: say so and read it as none.
 */
export const parseStoredTemplateIdList = (text: string | null): number[] | null => {
    if (text === null) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        console.warn('[prompt-templates] ignoring an unparsable stored template id list');
        return null;
    }
    const normalized = normalizeTemplateIdList(parsed);
    if (!normalized.ok) {
        console.warn(`[prompt-templates] ignoring an invalid stored template id list: ${normalized.message}`);
        return null;
    }
    return normalized.value;
};
