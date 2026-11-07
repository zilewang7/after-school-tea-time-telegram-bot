import { useCallback } from 'react';
import { useWebApp } from '../context/panel-context';
import { confirmWithTelegram, notifySuccessHaptic } from '../telegram-features';

/** Native confirm dialog; resolves true on clients that have none */
export const useConfirm = (): ((message: string) => Promise<boolean>) => {
    const webApp = useWebApp();
    return useCallback((message: string) => confirmWithTelegram(webApp, message), [webApp]);
};

/** The "success" haptic, for a save that went through */
export const useSuccessHaptic = (): (() => void) => {
    const webApp = useWebApp();
    return useCallback(() => notifySuccessHaptic(webApp), [webApp]);
};
