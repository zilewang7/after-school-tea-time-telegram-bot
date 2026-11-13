import { useCallback } from 'react';
import type { ChatSettings, ThinkingEffortView } from '../../api';
import { ModelPicker } from '../../components/model-picker';
import { SaveBar } from '../../components/save-bar';
import { ThinkingEffortField } from '../../components/thinking-effort-field';
import { ToggleRow } from '../../components/toggle-row';
import type { ChatGeminiPriorityState } from '../../gemini-priority';
import { useConfirm } from '../../hooks/use-telegram-feedback';
import { AddendumEditor } from './addendum-editor';
import { GeminiPriorityField } from './gemini-priority-field';
import { useChatSettingsForm } from './use-chat-settings-form';

const LOCK_CONFIRM_MESSAGE = '锁定后，只有机主能修改本聊天的设置。确定锁定？';
const UNLOCK_CONFIRM_MESSAGE = '解除锁定后，本聊天的成员都能修改设置。确定解除？';

interface ChatSettingsFormProps {
    chatId: number;
    settings: ChatSettings;
    effectiveModel: string;
    globalDefaultModel: string;
    geminiPriority: ChatGeminiPriorityState;
    // The chat's thinking level and the effective model's graded efforts
    thinkingEffortView: ThinkingEffortView;
    models: readonly string[];
    isOwner: boolean;
    // Trial users keep the fixed trial model: the picker and the thinking level are disabled
    isTrial: boolean;
    trialModel: string;
    writable: boolean;
    justSaved: boolean;
    onSaved: (settings: ChatSettings) => void;
    onReload: () => void;
}

/** Model, thinking level, addendum, pause, Priority PayGo and (owner) lock, saved together as one PATCH of the changed keys */
export const ChatSettingsForm = ({
    chatId,
    settings,
    effectiveModel,
    globalDefaultModel,
    geminiPriority,
    thinkingEffortView,
    models,
    isOwner,
    isTrial,
    trialModel,
    writable,
    justSaved,
    onSaved,
    onReload,
}: ChatSettingsFormProps) => {
    const form = useChatSettingsForm({ chatId, settings, models, writable, onSaved });
    // Frozen while saving: a successful save rebuilds the form from the server, which would drop later typing
    const disabled = !writable || form.saving;
    const confirm = useConfirm();
    const { setSettingsLocked } = form;

    // The switch only moves once the owner confirms; saving still takes the MainButton
    const handleLockChange = useCallback(
        (locked: boolean) => {
            // Undoing an unsaved change needs no confirmation
            if (locked === settings.settingsLocked) {
                setSettingsLocked(locked);
                return;
            }
            void confirm(locked ? LOCK_CONFIRM_MESSAGE : UNLOCK_CONFIRM_MESSAGE).then((confirmed) => {
                if (confirmed) setSettingsLocked(locked);
            });
        },
        [settings.settingsLocked, confirm, setSettingsLocked]
    );

    return (
        <section className="section">
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
                    disabled={disabled || isTrial}
                    onChange={form.setModelDraft}
                />
                {isTrial ? (
                    <p className="hint">体验用户固定使用 {trialModel}，不能修改模型；可在「准入」页申请完整功能。</p>
                ) : (
                    <p className="hint">当前生效：{effectiveModel}</p>
                )}
            </div>

            <ThinkingEffortField
                view={thinkingEffortView}
                choice={form.thinkingEffort}
                disabled={disabled || isTrial}
                onChange={form.setThinkingEffort}
            />
            {isTrial && <p className="hint">体验用户不能修改思考等级；可在「准入」页申请完整功能。</p>}

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
            <GeminiPriorityField
                choice={form.geminiPriority}
                savedChoice={settings.geminiPriority}
                state={geminiPriority}
                isOwner={isOwner}
                disabled={disabled}
                onChange={form.setGeminiPriority}
            />
            {isOwner && (
                <ToggleRow
                    label="锁定设置"
                    description="锁定后只有机主能改本聊天的设置"
                    checked={form.settingsLocked}
                    disabled={form.saving}
                    onChange={handleLockChange}
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
