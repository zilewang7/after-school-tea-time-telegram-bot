import { match } from 'ts-pattern';
import type { PreviewState } from './use-addendum-preview';

interface AddendumPreviewViewProps {
    state: PreviewState;
    // Normalized addendum currently in the editor, to flag a preview that no longer matches it
    currentValue: string;
}

export const AddendumPreviewView = ({ state, currentValue }: AddendumPreviewViewProps) =>
    match(state)
        .with({ kind: 'idle' }, () => null)
        .with({ kind: 'loading' }, () => <p className="hint">正在生成预览…</p>)
        .with({ kind: 'failed' }, ({ message }) => <p className="error-text">{message}</p>)
        .with({ kind: 'ready' }, ({ previewedValue, result }) => (
            <div className="preview">
                {!result.injected && <p className="notice warning">当前模型下附加提示词不生效</p>}
                {previewedValue !== currentValue && <p className="hint">内容已修改，预览可能已过期</p>}
                <pre className="code-block">{result.runtimeBlock}</pre>
                <p className="hint">约 {result.estimatedTokens} token · 名册在实际回复时按上下文生成</p>
            </div>
        ))
        .exhaustive();
