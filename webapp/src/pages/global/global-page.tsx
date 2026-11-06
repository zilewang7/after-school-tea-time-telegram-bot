import { useCallback, useState } from 'react';
import { match } from 'ts-pattern';
import type { GlobalSettingsResponse } from '../../api';
import { ErrorView, LoadingView } from '../../components/status-views';
import { useMe } from '../../context/me-context';
import { useApi } from '../../context/panel-context';
import { useApiQuery } from '../../hooks/use-api-query';
import { GlobalSettingsForm } from './global-settings-form';

const GlobalSettingsSection = () => {
    const api = useApi();
    const { me, refreshMe } = useMe();
    const loadGlobal = useCallback((signal: AbortSignal) => api.getGlobal(signal), [api]);
    const { state, reload, update } = useApiQuery(loadGlobal);
    const [justSaved, setJustSaved] = useState(false);

    const handleSaved = useCallback(
        (global: GlobalSettingsResponse) => {
            update(() => global);
            setJustSaved(true);
            // The chat list shows the global default for chats that follow it
            refreshMe();
        },
        [update, refreshMe]
    );

    const handleReload = useCallback(() => {
        setJustSaved(false);
        reload();
    }, [reload]);

    return match(state)
        .with({ status: 'loading' }, () => <LoadingView />)
        .with({ status: 'error' }, ({ failure }) => <ErrorView failure={failure} onRetry={handleReload} />)
        .with({ status: 'success' }, ({ data }) => (
            <GlobalSettingsForm
                // Re-created from server state after every save
                key={`${data.source}:${data.defaultModel}`}
                global={data}
                models={me.models}
                justSaved={justSaved}
                onSaved={handleSaved}
                onReload={handleReload}
            />
        ))
        .exhaustive();
};

/** /global (owner only) */
export const GlobalPage = () => {
    const { me } = useMe();
    return (
        <>
            <header className="page-header">
                <h1>全局设置</h1>
            </header>
            {me.isOwner ? <GlobalSettingsSection /> : <p className="placeholder">仅机主可以修改全局设置</p>}
        </>
    );
};
