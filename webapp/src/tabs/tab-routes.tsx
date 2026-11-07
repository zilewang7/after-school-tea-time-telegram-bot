import { Navigate } from 'react-router';
import type { RouteObject } from 'react-router';
import { useTabLayer } from './tab-layer-context';
import type { TabDefinition } from './tab-types';

interface TabRouteProps {
    tab: TabDefinition;
}

/** A tab's page, or a redirect to the layer root when the tab is hidden from this user */
const TabRoute = ({ tab }: TabRouteProps) => {
    const { visibility, rootPath } = useTabLayer();
    if (!tab.isVisible(visibility)) return <Navigate replace to={rootPath} />;
    const Page = tab.page;
    return <Page />;
};

/** One route per registry entry, for the children of a tab layer's layout route */
export const tabRoutesOf = (tabs: readonly TabDefinition[]): RouteObject[] =>
    tabs.map((tab) =>
        tab.path === ''
            ? { index: true, element: <TabRoute tab={tab} /> }
            : { path: tab.path, element: <TabRoute tab={tab} /> }
    );
