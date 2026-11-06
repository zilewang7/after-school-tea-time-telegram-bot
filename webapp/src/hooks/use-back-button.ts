import { useEffect } from 'react';
import { useWebApp } from '../context/panel-context';

/** Shows Telegram's BackButton while onBack is set; hides it for null */
export const useBackButton = (onBack: (() => void) | null): void => {
    const webApp = useWebApp();

    useEffect(() => {
        const backButton = webApp.BackButton;
        if (onBack === null) {
            backButton.hide();
            return;
        }
        backButton.onClick(onBack);
        backButton.show();
        return () => {
            backButton.offClick(onBack);
            backButton.hide();
        };
    }, [webApp, onBack]);
};
