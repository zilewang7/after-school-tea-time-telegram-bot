import type { GlobalSettingsResponse } from '../../api';
import { ModelPicker } from '../../components/model-picker';
import { SaveBar } from '../../components/save-bar';
import { useGlobalSettingsForm } from './use-global-settings-form';

interface GlobalSettingsFormProps {
    global: GlobalSettingsResponse;
    models: readonly string[];
    justSaved: boolean;
    onSaved: (global: GlobalSettingsResponse) => void;
    onReload: () => void;
}

export const GlobalSettingsForm = ({ global, models, justSaved, onSaved, onReload }: GlobalSettingsFormProps) => {
    const form = useGlobalSettingsForm({ global, models, onSaved });

    return (
        <section className="section">
            <h2 className="section-title">全局默认模型</h2>
            <div className="field-group">
                <label htmlFor="global-model" className="field-label">
                    没有单独设置模型的聊天都用它
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
                    当前：{global.defaultModel}（{global.source === 'panel' ? '面板设置' : '来自环境变量'}）
                </p>
            </div>
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
