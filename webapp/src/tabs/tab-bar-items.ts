import type { TabBarItem } from '../components/tab-bar';
import type { TabDefinition, TabVisibility } from './tab-types';

/** The visible tabs of a registry as tab bar items; `pathOf` turns a tab's path segment into its absolute path */
export const tabBarItemsOf = (
    tabs: readonly TabDefinition[],
    visibility: TabVisibility,
    pathOf: (tabPath: string) => string
): TabBarItem[] =>
    tabs
        .filter((tab) => tab.isVisible(visibility))
        .map((tab) => ({ id: tab.id, label: tab.label, to: pathOf(tab.path), badge: tab.badge ?? null }));
