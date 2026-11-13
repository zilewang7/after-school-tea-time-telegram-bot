import { useCallback, useState } from 'react';
import { match } from 'ts-pattern';
import type { GlobalSettingsResponse } from '../../api';
import { NavListItem } from '../../components/nav-list-item';
import { ErrorView, LoadingView } from '../../components/status-views';
import { useMe } from '../../context/me-context';
import { useApi } from '../../context/panel-context';
import { useApiQuery } from '../../hooks/use-api-query';
import { useSuccessHaptic } from '../../hooks/use-telegram-feedback';
import { GLOBAL_AUDIT_PATH, GLOBAL_MODEL_CATALOG_PATH } from '../../routing/paths';
import { GlobalSettingsForm } from './global-settings-form';

const GlobalSettingsSection = () => {
    const api = useApi();
    const { me, refreshMe } = useMe();
    const loadGlobal = useCallback((signal: AbortSignal) => api.getGlobal(signal), [api]);
    const { state, reload, update } = useApiQuery(loadGlobal);
    const [justSaved, setJustSaved] = useState(false);
    const notifySaved = useSuccessHaptic();

    const handleSaved = useCallback(
        (global: GlobalSettingsResponse) => {
            update(() => global);
            setJustSaved(true);
            notifySaved();
            // The chat list shows the global default for chats that follow it
            refreshMe();
        },
        [update, notifySaved, refreshMe]
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
                key={`${data.source}:${data.defaultModel}:${String(data.defaultGeminiPriority)}`}
                global={data}
                models={me.models}
                justSaved={justSaved}
                onSaved={handleSaved}
                onReload={handleReload}
            />
        ))
        .exhaustive();
};

/** /settings (owner only; the tab is hidden from everyone else) */
export const HomeSettingsTab = () => (
    <>
        <GlobalSettingsSection />
        <section className="section">
            <ul className="list">
                <NavListItem to={GLOBAL_AUDIT_PATH} label="全部改动" />
                <NavListItem to={GLOBAL_MODEL_CATALOG_PATH} label="模型能力目录" />
            </ul>
        </section>
    </>
);
