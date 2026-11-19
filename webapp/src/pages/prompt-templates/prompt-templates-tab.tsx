import { useCallback, useState } from 'react';
import { describeWriteFailure } from '../../api';
import type { PromptTemplateSummary } from '../../api';
import { useMe } from '../../context/me-context';
import { useApi } from '../../context/panel-context';
import { useApiQuery } from '../../hooks/use-api-query';
import { useConfirm, useSuccessHaptic } from '../../hooks/use-telegram-feedback';
import { promptTemplateDeleteMessage } from '../../prompt-templates';
import { PromptTemplateEditor } from './prompt-template-editor';
import { PromptTemplateList } from './prompt-template-list';

type EditorState = { kind: 'closed' } | { kind: 'create' } | { kind: 'edit'; templateId: number };

/** /templates: every panel user's prompt templates; the owner manages everyone's */
export const PromptTemplatesTab = () => {
    const api = useApi();
    const { me } = useMe();
    const load = useCallback((signal: AbortSignal) => api.getPromptTemplates(signal), [api]);
    const query = useApiQuery(load);
    const { refresh: refreshList, update: updateList } = query;
    const [editor, setEditor] = useState<EditorState>({ kind: 'closed' });
    const [pendingId, setPendingId] = useState<number | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const confirm = useConfirm();
    const notifySaved = useSuccessHaptic();

    const handleCreate = useCallback(() => {
        setActionError(null);
        setEditor({ kind: 'create' });
    }, []);
    const handleEdit = useCallback((templateId: number) => {
        setActionError(null);
        setEditor({ kind: 'edit', templateId });
    }, []);
    const handleCancel = useCallback(() => setEditor({ kind: 'closed' }), []);
    const handleSaved = useCallback(() => {
        setEditor({ kind: 'closed' });
        notifySaved();
        refreshList();
    }, [notifySaved, refreshList]);

    const handleToggleEnabled = useCallback(
        (template: PromptTemplateSummary, enabled: boolean) => {
            setActionError(null);
            setPendingId(template.id);
            void api.patchPromptTemplate(template.id, { enabled }).then((result) => {
                setPendingId(null);
                if (!result.ok) {
                    setActionError(describeWriteFailure(result.failure).message);
                    return;
                }
                updateList((data) => ({
                    templates: data.templates.map((row) =>
                        row.id === result.data.template.id ? { ...row, enabled: result.data.template.enabled } : row
                    ),
                }));
            });
        },
        [api, updateList]
    );

    const handleDelete = useCallback(
        (template: PromptTemplateSummary) => {
            // Web login has no native confirm dialog: the text must not be the only guard
            void confirm(promptTemplateDeleteMessage(template)).then((confirmed) => {
                if (!confirmed) return;
                setActionError(null);
                setPendingId(template.id);
                void api.deletePromptTemplate(template.id).then((result) => {
                    setPendingId(null);
                    if (!result.ok) {
                        setActionError(describeWriteFailure(result.failure).message);
                        return;
                    }
                    refreshList();
                });
            });
        },
        [confirm, api, refreshList]
    );

    return (
        <>
            <header className="page-header">
                <h1>模板</h1>
                <p className="hint">
                    模板要在会话的「设置 → 提示词模板」里启用，或在该会话打开「按模型匹配自动加载」，才会生效。
                </p>
                <p className="hint">
                    「完全隐藏」只有自己可用；「同群群聊用户可见」对与创建者同群的面板用户可见。机主可以查看和管理所有模板。
                </p>
            </header>
            <section className="section">
                {editor.kind === 'closed' ? (
                    <button type="button" className="button primary" onClick={handleCreate}>
                        新建模板
                    </button>
                ) : (
                    <PromptTemplateEditor
                        templateId={editor.kind === 'create' ? null : editor.templateId}
                        onSaved={handleSaved}
                        onCancel={handleCancel}
                    />
                )}
                {actionError !== null && <p className="error-text">{actionError}</p>}
                <PromptTemplateList
                    query={query}
                    pendingId={pendingId}
                    showCreator={me.isOwner}
                    onToggleEnabled={handleToggleEnabled}
                    onEdit={handleEdit}
                    onDelete={handleDelete}
                />
            </section>
        </>
    );
};
