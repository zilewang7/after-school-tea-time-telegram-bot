import { useCallback } from 'react';
import { useWebApp } from '../context/panel-context';
import { useMainButton } from './use-main-button';

export interface SaveMainButtonOptions {
    // False when the form is read-only for this user (e.g. locked and not owner)
    writable: boolean;
    dirty: boolean;
    valid: boolean;
    saving: boolean;
    expired: boolean;
    onSave: () => void;
}

/**
 * MainButton for a settings form: 「保存」 while there are valid changes,
 * 「重新打开」 (closes the panel) once initData is too old to write.
 */
export const useSaveMainButton = ({ writable, dirty, valid, saving, expired, onSave }: SaveMainButtonOptions): void => {
    const webApp = useWebApp();
    const closePanel = useCallback(() => webApp.close(), [webApp]);

    const reopenMode = writable && expired;
    useMainButton({
        text: reopenMode ? '重新打开' : '保存',
        visible: reopenMode || (writable && dirty),
        enabled: reopenMode || (valid && !saving),
        progress: !reopenMode && saving,
        onClick: reopenMode ? closePanel : onSave,
    });
};
