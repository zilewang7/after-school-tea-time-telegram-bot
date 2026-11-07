import { createContext, useContext } from 'react';
import type { TabVisibility } from './tab-types';

export interface TabLayerValue {
    visibility: TabVisibility;
    /** The layer's root, where a hidden tab's route sends the user: "/" or "/c/:chatId" */
    rootPath: string;
}

/** Provided by a tab layer's layout (home or chat) to the tab routes below it */
export const TabLayerContext = createContext<TabLayerValue | null>(null);

export const useTabLayer = (): TabLayerValue => {
    const value = useContext(TabLayerContext);
    if (value === null) throw new Error('TabLayerContext is missing');
    return value;
};
