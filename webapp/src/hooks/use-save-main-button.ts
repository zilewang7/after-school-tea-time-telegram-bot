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
    // 「保存」 or 「提交」
    label: string;
    onSave: () => void;
}

/**
 * MainButton for a form: the label while there are valid changes,
 * 「重新打开」 (closes the panel) once initData is too old to write.
 * Hidden again when the form unmounts, e.g. on a tab switch.
 */
export const useSaveMainButton = ({
    writable,
    dirty,
    valid,
    saving,
    expired,
    label,
    onSave,
}: SaveMainButtonOptions): void => {
    const webApp = useWebApp();
    const closePanel = useCallback(() => webApp.close(), [webApp]);

    const reopenMode = writable && expired;
    useMainButton({
        text: reopenMode ? '重新打开' : label,
        visible: reopenMode || (writable && dirty),
        enabled: reopenMode || (valid && !saving),
        progress: !reopenMode && saving,
        onClick: reopenMode ? closePanel : onSave,
    });
};
