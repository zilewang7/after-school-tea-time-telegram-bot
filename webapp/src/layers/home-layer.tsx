import { Suspense, useMemo } from 'react';
import { Outlet, useLocation } from 'react-router';
import { LoadingView } from '../components/status-views';
import { TabBar } from '../components/tab-bar';
import { useMe } from '../context/me-context';
import { userDisplayName } from '../format';
import { HOME_PATH, homeTabPath, pathSegmentsOf } from '../routing/paths';
import { tabAtLayerPath } from '../routing/tab-choice';
import { HOME_TABS } from '../tabs/home-tabs';
import { tabBarItemsOf } from '../tabs/tab-bar-items';
import { TabLayerContext } from '../tabs/tab-layer-context';
import type { TabLayerValue } from '../tabs/tab-layer-context';
import type { TabVisibility } from '../tabs/tab-types';

/** The home layer's tab pages: title, sticky tab bar, then the active tab */
export const HomeLayer = () => {
    const { me } = useMe();
    const { pathname } = useLocation();

    const visibility = useMemo<TabVisibility>(() => ({ isOwner: me.isOwner, access: null }), [me.isOwner]);
    const tabItems = useMemo(() => tabBarItemsOf(HOME_TABS, visibility, homeTabPath), [visibility]);
    const activeTab = useMemo(() => tabAtLayerPath(HOME_TABS, pathSegmentsOf(pathname)), [pathname]);
    const layerValue = useMemo<TabLayerValue>(() => ({ visibility, rootPath: HOME_PATH }), [visibility]);

    return (
        <TabLayerContext.Provider value={layerValue}>
            <header className="layer-header">
                <h1>控制面板</h1>
                <p className="hint">
                    {userDisplayName(me.user)}
                    {me.isOwner ? ' · 机主' : ''}
                </p>
            </header>
            <TabBar items={tabItems} activeId={activeTab?.id ?? null} />
            <Suspense fallback={<LoadingView />}>
                <Outlet />
            </Suspense>
        </TabLayerContext.Provider>
    );
};
