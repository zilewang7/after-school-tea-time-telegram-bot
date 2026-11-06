import { useCallback, useState } from 'react';
import { match } from 'ts-pattern';
import type { ChatSettings } from '../../api';
import { ErrorView, LoadingView } from '../../components/status-views';
import { useMe } from '../../context/me-context';
import { useApi } from '../../context/panel-context';
import { useApiQuery } from '../../hooks/use-api-query';
import { Dashboard } from './dashboard';

interface DashboardPageProps {
    chatId: number;
}

/** Loads one chat's dashboard and applies saved settings back into it */
export const DashboardPage = ({ chatId }: DashboardPageProps) => {
    const api = useApi();
    const { me, refreshMe } = useMe();
    const loadChat = useCallback((signal: AbortSignal) => api.getChat(chatId, signal), [api, chatId]);
    const { state, reload, refresh, update } = useApiQuery(loadChat);
    const [justSaved, setJustSaved] = useState(false);

    const handleSaved = useCallback(
        (settings: ChatSettings) => {
            update((detail) => ({
                ...detail,
                settings,
                effectiveModel: settings.model ?? detail.globalDefaultModel,
            }));
            setJustSaved(true);
            // Tools and recent audit depend on the new settings; the chat list shows them too
            refresh();
            refreshMe();
        },
        [update, refresh, refreshMe]
    );

    const handleReload = useCallback(() => {
        setJustSaved(false);
        reload();
    }, [reload]);

    return match(state)
        .with({ status: 'loading' }, () => <LoadingView />)
        .with({ status: 'error' }, ({ failure }) => <ErrorView failure={failure} onRetry={handleReload} />)
        .with({ status: 'success' }, ({ data }) => (
            <Dashboard
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
