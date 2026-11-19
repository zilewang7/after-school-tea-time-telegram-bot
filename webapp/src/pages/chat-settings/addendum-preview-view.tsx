import { match } from 'ts-pattern';
import type { AddendumPreviewDraft, PreviewState } from './use-addendum-preview';
import { sameAddendumPreviewDraft } from './use-addendum-preview';

interface AddendumPreviewViewProps {
    state: PreviewState;
    // The form's current draft, to flag a preview that no longer matches it
    currentDraft: AddendumPreviewDraft;
}

const appliedTemplatesLabel = (names: readonly string[]): string => (names.length === 0 ? '无' : names.join('、'));

export const AddendumPreviewView = ({ state, currentDraft }: AddendumPreviewViewProps) =>
    match(state)
        .with({ kind: 'idle' }, () => null)
        .with({ kind: 'loading' }, () => <p className="hint">正在生成预览…</p>)
        .with({ kind: 'failed' }, ({ message }) => <p className="error-text">{message}</p>)
        .with({ kind: 'ready' }, ({ previewedDraft, result }) => (
            <div className="preview">
                {!sameAddendumPreviewDraft(previewedDraft, currentDraft) && (
                    <p className="hint">内容已修改，预览可能已过期</p>
                )}
                <p className="hint">
                    已加载模板：{appliedTemplatesLabel(result.appliedTemplates.map((template) => template.name))}
                </p>
                {!result.injected && <p className="hint">没有可注入的内容</p>}
                <pre className="code-block">{result.runtimeBlock}</pre>
                <p className="hint">
                    合计 {result.composedCodePoints} 字 · 约 {result.estimatedTokens} token · 名册在实际回复时按上下文生成
                </p>
            </div>
        ))
        .exhaustive();
