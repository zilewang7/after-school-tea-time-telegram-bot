import { useEffect } from 'react';
import { useWebApp } from '../context/panel-context';

export interface MainButtonOptions {
    text: string;
    visible: boolean;
    enabled: boolean;
    progress: boolean;
    onClick: () => void;
}

/** Drives Telegram's MainButton singleton; only one mounted component should use it at a time */
export const useMainButton = ({ text, visible, enabled, progress, onClick }: MainButtonOptions): void => {
    const webApp = useWebApp();

    useEffect(() => {
        const mainButton = webApp.MainButton;
        mainButton.setText(text);
        if (enabled) mainButton.enable();
        else mainButton.disable();
        if (progress) mainButton.showProgress(false);
        else mainButton.hideProgress();
        if (visible) mainButton.show();
        else mainButton.hide();
    }, [webApp, text, visible, enabled, progress]);

    useEffect(() => {
        const mainButton = webApp.MainButton;
        mainButton.onClick(onClick);
        return () => mainButton.offClick(onClick);
    }, [webApp, onClick]);

    useEffect(() => {
        const mainButton = webApp.MainButton;
        return () => {
            mainButton.hideProgress();
            mainButton.hide();
        };
    }, [webApp]);
};
