import { match } from 'ts-pattern';

export const MODEL_ID_MAX_LENGTH = 64;

/** Editor state of a model setting; "unset" stores null (follow global / back to env) */
export type ModelDraft = { kind: 'unset' } | { kind: 'menu'; id: string } | { kind: 'custom'; text: string };

export type ResolvedModel = { ok: true; value: string | null } | { ok: false; error: string };

export const modelDraftOf = (value: string | null, models: readonly string[]): ModelDraft => {
    if (value === null) return { kind: 'unset' };
    return models.includes(value) ? { kind: 'menu', id: value } : { kind: 'custom', text: value };
};

/** Model ids are free text: any non-empty id up to 64 characters */
export const resolveModelDraft = (draft: ModelDraft): ResolvedModel =>
    match(draft)
        .returnType<ResolvedModel>()
        .with({ kind: 'unset' }, () => ({ ok: true, value: null }))
        .with({ kind: 'menu' }, ({ id }) => ({ ok: true, value: id }))
        .with({ kind: 'custom' }, ({ text }) => {
            const modelId = text.trim();
            if (modelId === '') return { ok: false, error: '请填写模型 id' };
            if (Array.from(modelId).length > MODEL_ID_MAX_LENGTH) {
                return { ok: false, error: `模型 id 最多 ${MODEL_ID_MAX_LENGTH} 个字符` };
            }
            return { ok: true, value: modelId };
        })
        .exhaustive();
