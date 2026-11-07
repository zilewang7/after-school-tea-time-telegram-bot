import { useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { canGoBackInApp, parentPathOf } from '../routing/back-target';
import type { LayerTabPaths } from '../routing/back-target';
import { CHAT_TABS } from '../tabs/chat-tabs';
import { HOME_TABS } from '../tabs/home-tabs';
import { useBackButton } from './use-back-button';

const TAB_PATHS: LayerTabPaths = {
    home: new Set(HOME_TABS.map((tab) => tab.path)),
    chat: new Set(CHAT_TABS.map((tab) => tab.path)),
};

/**
 * Telegram's BackButton, hidden on home tabs. It steps back through in-app
 * history, so a drill-down returns to the very list it came from (tab switches
 * replace entries, so that is one layer up); a page opened directly goes to
 * its logical parent instead.
 */
export const useNavigationBackButton = (): void => {
    const { pathname } = useLocation();
    const navigate = useNavigate();
    const parentPath = parentPathOf(pathname, TAB_PATHS);

    const goBack = useMemo(() => {
        if (parentPath === null) return null;
        return () => {
            if (canGoBackInApp(window.history.state)) void navigate(-1);
            else void navigate(parentPath, { replace: true });
        };
    }, [parentPath, navigate]);
    useBackButton(goBack);
};
