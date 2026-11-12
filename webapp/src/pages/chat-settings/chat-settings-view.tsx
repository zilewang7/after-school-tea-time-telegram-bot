import { useMemo } from 'react';
import type { ChatDetailResponse, ChatSettings } from '../../api';
import type { ChatGeminiPriorityState } from '../../gemini-priority';
import { ChatSettingsForm } from './chat-settings-form';
import { RecentAudit } from './recent-audit';
import { ToolSummaryRow } from './tool-summary-row';

interface ChatSettingsViewProps {
    detail: ChatDetailResponse;
    isOwner: boolean;
    models: readonly string[];
    justSaved: boolean;
    onSaved: (settings: ChatSettings) => void;
    onReload: () => void;
}

export const ChatSettingsView = ({ detail, isOwner, models, justSaved, onSaved, onReload }: ChatSettingsViewProps) => {
    const { chat, settings, effectiveGeminiPriority, globalGeminiPriority, geminiPriorityCanEnable } = detail;
    // Locking only binds non-owners
    const writable = !settings.settingsLocked || isOwner;
    const geminiPriority = useMemo<ChatGeminiPriorityState>(
        () => ({
            effective: effectiveGeminiPriority,
            globalOn: globalGeminiPriority,
            canEnable: geminiPriorityCanEnable,
        }),
        [effectiveGeminiPriority, globalGeminiPriority, geminiPriorityCanEnable]
    );

    return (
        <>
            <ChatSettingsForm
                // Re-created from server state after every save or refresh, so the draft never drifts from it
                key={settings.updatedAt ?? 'never-saved'}
                chatId={chat.chatId}
                settings={settings}
                effectiveModel={detail.effectiveModel}
                globalDefaultModel={detail.globalDefaultModel}
                geminiPriority={geminiPriority}
                models={models}
                isOwner={isOwner}
                writable={writable}
                justSaved={justSaved}
                onSaved={onSaved}
                onReload={onReload}
            />
            {/* The 7-day summary lives in the 统计 tab, not here */}
            <ToolSummaryRow chatId={chat.chatId} tools={detail.tools} />
            <RecentAudit chatId={chat.chatId} entries={detail.recentAudit} />
        </>
    );
};
