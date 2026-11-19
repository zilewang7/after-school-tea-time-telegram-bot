import { useCallback, useMemo } from 'react';
import type { ChatPromptTemplateListResponse, ChatSettings, ThinkingEffortView } from '../../api';
import { ModelPicker } from '../../components/model-picker';
import { SaveBar } from '../../components/save-bar';
import { ThinkingEffortField } from '../../components/thinking-effort-field';
import { ToggleRow } from '../../components/toggle-row';
import type { ChatGeminiPriorityState } from '../../gemini-priority';
import type { ApiQuery } from '../../hooks/use-api-query';
import { useConfirm } from '../../hooks/use-telegram-feedback';
import { AddendumEditor } from './addendum-editor';
import { GeminiPriorityField } from './gemini-priority-field';
import { PromptTemplatesField } from './prompt-templates-field';
import { useChatSettingsForm } from './use-chat-settings-form';

const LOCK_CONFIRM_MESSAGE = '锁定后，只有机主能修改本聊天的设置。确定锁定？';
const UNLOCK_CONFIRM_MESSAGE = '解除锁定后，本聊天的成员都能修改设置。确定解除？';
// Stable empty list: the query's data is missing until it loads
const NO_TEMPLATES: ChatPromptTemplateListResponse['templates'] = [];

interface ChatSettingsFormProps {
    chatId: number;
    settings: ChatSettings;
    effectiveModel: string;
    globalDefaultModel: string;
    geminiPriority: ChatGeminiPriorityState;
    // The chat's thinking level and the effective model's graded efforts
    thinkingEffortView: ThinkingEffortView;
    models: readonly string[];
    // The visible templates: the field lists them, the form sums their lengths for the 8000 limit
    chatTemplates: ApiQuery<ChatPromptTemplateListResponse>;
    // The viewer's Telegram user id, to name the creator of someone else's template
    viewerId: number;
    isOwner: boolean;
    // Trial users keep the fixed trial model: the picker and the thinking level are disabled
    isTrial: boolean;
    trialModel: string;
    writable: boolean;
    justSaved: boolean;
    onSaved: (settings: ChatSettings) => void;
    onReload: () => void;
}

/** Model, thinking level, addendum, prompt templates, pause, rich replies, Priority PayGo and (owner) lock, saved together as one PATCH of the changed keys */
export const ChatSettingsForm = ({
    chatId,
    settings,
    effectiveModel,
    globalDefaultModel,
    geminiPriority,
    thinkingEffortView,
    models,
    chatTemplates,
    viewerId,
    isOwner,
    isTrial,
    trialModel,
    writable,
    justSaved,
    onSaved,
    onReload,
}: ChatSettingsFormProps) => {
    const templateList = useMemo(
        () => (chatTemplates.state.status === 'success' ? chatTemplates.state.data.templates : NO_TEMPLATES),
        [chatTemplates.state]
    );
    const form = useChatSettingsForm({ chatId, settings, models, templates: templateList, writable, onSaved });
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
                templateIds={form.templateIds}
                promptTemplatesAuto={form.promptTemplatesAuto}
                disabled={disabled}
                onChange={form.setAddendumText}
            />

            <PromptTemplatesField
                templates={chatTemplates}
                selectedIds={form.templateIds}
                auto={form.promptTemplatesAuto}
                templateContentLength={form.templateContentLength}
                addendumLength={form.addendumLength}
                effectiveModel={effectiveModel}
                viewerId={viewerId}
                disabled={disabled}
                onAutoChange={form.setPromptTemplatesAuto}
                onToggleTemplate={form.toggleTemplateId}
            />

            <ToggleRow
                label="暂停 bot"
                description="暂停后 bot 在本聊天不再回复"
                checked={form.paused}
                disabled={disabled}
                onChange={form.setPaused}
            />
            <ToggleRow
                label="富文本回复"
                description="实验功能：长回复会被客户端自动折叠、不便引用，其他 bot 可能读不到内容"
                checked={form.richReplies}
                disabled={disabled}
                onChange={form.setRichReplies}
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
