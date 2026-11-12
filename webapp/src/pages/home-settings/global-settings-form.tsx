import type { GlobalSettingsResponse } from '../../api';
import { ModelPicker } from '../../components/model-picker';
import { SaveBar } from '../../components/save-bar';
import { GlobalPriorityField } from './global-priority-field';
import { useGlobalSettingsForm } from './use-global-settings-form';

interface GlobalSettingsFormProps {
    global: GlobalSettingsResponse;
    models: readonly string[];
    justSaved: boolean;
    onSaved: (global: GlobalSettingsResponse) => void;
    onReload: () => void;
}

/** Default model and Priority PayGo, saved together as one PATCH of the changed keys */
export const GlobalSettingsForm = ({ global, models, justSaved, onSaved, onReload }: GlobalSettingsFormProps) => {
    const form = useGlobalSettingsForm({ global, models, onSaved });
    const modelSourceLabel = global.source === 'panel' ? '面板设置' : '来自环境变量';

    return (
        <section className="section">
            <h2 className="section-title">全局设置</h2>
            <div className="field-group">
                <label htmlFor="global-model" className="field-label">
                    默认模型
                </label>
                <ModelPicker
                    inputId="global-model"
                    models={models}
                    draft={form.modelDraft}
                    unsetLabel={global.source === 'panel' ? '恢复为环境变量 DEFAULT_MODEL' : null}
                    error={form.modelError}
                    disabled={form.saving}
                    onChange={form.setModelDraft}
                />
                <p className="hint">
                    没有单独设置模型的聊天都用它。当前：{global.defaultModel}（{modelSourceLabel}）
                </p>
            </div>
            <GlobalPriorityField
                checked={form.geminiPriority}
                disabled={form.saving}
                onChange={form.setGeminiPriority}
            />
            {/* The page's only SaveBar: a second one would fight over Telegram's MainButton */}
            <SaveBar
                writable
                dirty={form.dirty}
                valid={form.valid}
                status={form.saveStatus}
                justSaved={justSaved}
                savedMessage="已保存，立即对跟随全局的聊天生效"
                pendingHint="保存后立即对跟随全局的聊天生效"
                onSave={form.save}
                onRefresh={onReload}
            />
        </section>
    );
};
