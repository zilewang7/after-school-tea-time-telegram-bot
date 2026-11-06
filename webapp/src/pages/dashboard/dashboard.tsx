import type { ChatDetailResponse, ChatSettings } from '../../api';
import { chatTitleOf } from '../../format';
import { ChatSettingsForm } from './chat-settings-form';
import { IdentityLine } from './identity-line';
import { RecentAudit } from './recent-audit';
import { ToolMatrix } from './tool-matrix';

interface DashboardProps {
    detail: ChatDetailResponse;
    isOwner: boolean;
    models: readonly string[];
    justSaved: boolean;
    onSaved: (settings: ChatSettings) => void;
    onReload: () => void;
}

export const Dashboard = ({ detail, isOwner, models, justSaved, onSaved, onReload }: DashboardProps) => {
    const { chat, settings } = detail;
    // Locking only binds non-owners
    const writable = !settings.settingsLocked || isOwner;

    return (
        <>
            <header className="page-header">
                <h1>{chatTitleOf(chat.title, chat.chatId)}</h1>
                <IdentityLine type={chat.type} access={chat.access} locked={settings.settingsLocked} />
            </header>
            <ChatSettingsForm
                // Re-created from server state after every save or refresh, so the draft never drifts from it
                key={settings.updatedAt ?? 'never-saved'}
                chatId={chat.chatId}
                settings={settings}
                effectiveModel={detail.effectiveModel}
                globalDefaultModel={detail.globalDefaultModel}
                models={models}
                isOwner={isOwner}
                writable={writable}
                justSaved={justSaved}
                onSaved={onSaved}
                onReload={onReload}
            />
            {/* The 7-day summary block stays hidden while summary is null (phases 1-2) */}
            <ToolMatrix tools={detail.tools} />
            <RecentAudit chatId={chat.chatId} entries={detail.recentAudit} />
        </>
    );
};
