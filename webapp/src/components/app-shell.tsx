import { Suspense, useCallback, useMemo } from 'react';
import { Outlet, ScrollRestoration } from 'react-router';
import { useApi } from '../context/panel-context';
import { MeContext } from '../context/me-context';
import type { MeContextValue } from '../context/me-context';
import { useApiQuery } from '../hooks/use-api-query';
import { useNavigationBackButton } from '../hooks/use-navigation-back-button';
import { useRouteMemory } from '../hooks/use-route-memory';
import type { LaunchState } from '../launch';
import { ConnectivityBanner } from './connectivity-banner';
import { ErrorView, LoadingView } from './status-views';

interface AppShellProps {
    launch: LaunchState;
}

/** Root layout: loads /api/me once for every page, owns the banner, BackButton, route memory and scroll restoration */
export const AppShell = ({ launch }: AppShellProps) => {
    const api = useApi();
    const loadMe = useCallback((signal: AbortSignal) => api.getMe(signal), [api]);
    const { state: meState, reload: reloadMe, refresh: refreshMe } = useApiQuery(loadMe);

    const me = meState.status === 'success' ? meState.data : null;
    useRouteMemory(launch, me);
    useNavigationBackButton();

    const meContextValue = useMemo<MeContextValue | null>(
        () => (me === null ? null : { me, refreshMe }),
        [me, refreshMe]
    );

    return (
        <div className="app">
            {/*
              Saves the scroll position per history entry and restores it when Back returns to that entry.
              Tab switches replace the entry, so a tab starts at the top; a list returned to keeps its place
              as long as it renders its rows right away (see snapshot-store.ts).
            */}
            <ScrollRestoration />
            <ConnectivityBanner />
            <main className="page">
                {meContextValue !== null && (
                    <MeContext.Provider value={meContextValue}>
                        <Suspense fallback={<LoadingView />}>
                            <Outlet />
                        </Suspense>
                    </MeContext.Provider>
                )}
                {meState.status === 'loading' && <LoadingView />}
                {meState.status === 'error' && <ErrorView failure={meState.failure} onRetry={reloadMe} />}
            </main>
        </div>
    );
};
