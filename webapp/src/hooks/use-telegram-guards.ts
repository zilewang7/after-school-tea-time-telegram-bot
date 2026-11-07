import { useEffect } from 'react';
import { useWebApp } from '../context/panel-context';
import { holdClosingConfirmation, holdVerticalSwipeLock } from '../telegram-features';

/** Disables swipe-down-to-close while `active` (e.g. while a long text is being edited); restored on unmount */
export const useVerticalSwipeLock = (active: boolean): void => {
    const webApp = useWebApp();
    useEffect(() => {
        if (!active) return;
        return holdVerticalSwipeLock(webApp);
    }, [webApp, active]);
};

/** Telegram asks before closing the panel while `active` (unsaved changes); restored on unmount */
export const useClosingConfirmation = (active: boolean): void => {
    const webApp = useWebApp();
    useEffect(() => {
        if (!active) return;
        return holdClosingConfirmation(webApp);
    }, [webApp, active]);
};
