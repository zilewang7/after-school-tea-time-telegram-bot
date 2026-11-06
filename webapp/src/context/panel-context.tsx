import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { createApi } from '../api';
import type { PanelApi } from '../api';
import type { TelegramWebApp } from '../telegram';

interface PanelContextValue {
    webApp: TelegramWebApp;
    api: PanelApi;
}

const PanelContext = createContext<PanelContextValue | null>(null);

interface PanelProviderProps {
    webApp: TelegramWebApp;
    children: ReactNode;
}

export const PanelProvider = ({ webApp, children }: PanelProviderProps) => {
    const value = useMemo<PanelContextValue>(() => ({ webApp, api: createApi(webApp.initData) }), [webApp]);
    return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
};

const usePanelContext = (): PanelContextValue => {
    const value = useContext(PanelContext);
    if (value === null) throw new Error('PanelProvider is missing');
    return value;
};

export const useWebApp = (): TelegramWebApp => usePanelContext().webApp;

export const useApi = (): PanelApi => usePanelContext().api;
