import type { ChatSettings } from '../../api';
import { ModelPicker } from '../../components/model-picker';
import { SaveBar } from '../../components/save-bar';
import { ToggleRow } from '../../components/toggle-row';
import { AddendumEditor } from './addendum-editor';
import { useChatSettingsForm } from './use-chat-settings-form';

interface ChatSettingsFormProps {
    chatId: number;
    settings: ChatSettings;
    effectiveModel: string;
    globalDefaultModel: string;
    models: readonly string[];
    isOwner: boolean;
    writable: boolean;
    justSaved: boolean;
    onSaved: (settings: ChatSettings) => void;
    onReload: () => void;
}

/** Model, addendum, pause and (owner) lock, saved together as one PATCH of the changed keys */
export const ChatSettingsForm = ({
    chatId,
    settings,
    effectiveModel,
    globalDefaultModel,
    models,
    isOwner,
    writable,
    justSaved,
    onSaved,
    onReload,
}: ChatSettingsFormProps) => {
    const form = useChatSettingsForm({ chatId, settings, models, writable, onSaved });
    // Frozen while saving: a successful save rebuilds the form from the server, which would drop later typing
    const disabled = !writable || form.saving;

    return (
        <section className="section">
            <h2 className="section-title">设置</h2>
            {!writable && <p className="notice warning">设置已被机主锁定</p>}

            <div className="field-group">
                <label htmlFor="chat-model" className="field-label">
                    模型
                </label>
                <ModelPicker
                    inputId="chat-model"
                    models={models}
                    draft={form.modelDraft}
                    unsetLabel={`跟随全局默认（当前为 ${globalDefaultModel}）`}
                    error={form.modelError}
                    disabled={disabled}
                    onChange={form.setModelDraft}
                />
                <p className="hint">当前生效：{effectiveModel}</p>
            </div>

            <AddendumEditor
                chatId={chatId}
                text={form.addendumText}
                normalizedValue={form.addendumValue ?? ''}
                length={form.addendumLength}
                restoredFromDraft={form.restoredFromDraft}
                disabled={disabled}
                onChange={form.setAddendumText}
            />

            <ToggleRow
                label="暂停 bot"
                description="暂停后 bot 在本聊天不再回复"
                checked={form.paused}
                disabled={disabled}
                onChange={form.setPaused}
            />
            {isOwner && (
                <ToggleRow
                    label="锁定设置"
                    description="锁定后只有机主能改本聊天的设置"
                    checked={form.settingsLocked}
                    disabled={form.saving}
                    onChange={form.setSettingsLocked}
                />
            )}

            <SaveBar
                writable={writable}
                dirty={form.dirty}
                valid={form.valid}
                status={form.saveStatus}
                justSaved={justSaved}
                savedMessage="已保存，立即对本聊天后续回复生效"
                pendingHint="保存后立即对本聊天后续回复生效"
                onSave={form.save}
                onRefresh={onReload}
            />
        </section>
    );
};
