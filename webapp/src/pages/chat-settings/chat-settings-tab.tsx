import { useCallback, useState } from 'react';
import { match } from 'ts-pattern';
import type { ChatSettings } from '../../api';
import { ErrorView, LoadingView } from '../../components/status-views';
import { useChatScope } from '../../context/chat-scope-context';
import { useMe } from '../../context/me-context';
import { effectiveGeminiPriorityOf } from '../../gemini-priority';
import { useSuccessHaptic } from '../../hooks/use-telegram-feedback';
import { ChatSettingsView } from './chat-settings-view';

/** /c/:chatId/settings: the chat's settings, from the chat scope's shared detail */
export const ChatSettingsTab = () => {
    const { me, refreshMe } = useMe();
    const { detail } = useChatScope();
    const { state, reload, refresh, update } = detail;
    const [justSaved, setJustSaved] = useState(false);
    const notifySaved = useSuccessHaptic();

    const handleSaved = useCallback(
        (settings: ChatSettings) => {
            update((chatDetail) => ({
                ...chatDetail,
                settings,
                effectiveModel: settings.model ?? chatDetail.globalDefaultModel,
                // Until the refresh below brings the server's value
                effectiveGeminiPriority: effectiveGeminiPriorityOf(
                    settings.geminiPriority,
                    chatDetail.globalGeminiPriority,
                    chatDetail.geminiPriorityCanEnable
                ),
            }));
            setJustSaved(true);
            notifySaved();
            // Tools and recent audit depend on the new settings; the chat list shows them too
            refresh();
            refreshMe();
        },
        [update, notifySaved, refresh, refreshMe]
    );

    const handleReload = useCallback(() => {
        setJustSaved(false);
        reload();
    }, [reload]);

    return match(state)
        .with({ status: 'loading' }, () => <LoadingView />)
        .with({ status: 'error' }, ({ failure }) => <ErrorView failure={failure} onRetry={handleReload} />)
        .with({ status: 'success' }, ({ data }) => (
            <ChatSettingsView
                detail={data}
                isOwner={me.isOwner}
                models={me.models}
                justSaved={justSaved}
                onSaved={handleSaved}
                onReload={handleReload}
            />
        ))
        .exhaustive();
};
