import { useMainButton } from './use-main-button';

export interface SaveMainButtonOptions {
    // False when the form is read-only for this user (e.g. locked and not owner)
    writable: boolean;
    dirty: boolean;
    valid: boolean;
    saving: boolean;
    // 「保存」 or 「提交」
    label: string;
    onSave: () => void;
}

/**
 * MainButton for a form: the label while there are valid changes.
 * Hidden again when the form unmounts, e.g. on a tab switch.
 */
export const useSaveMainButton = ({
    writable,
    dirty,
    valid,
    saving,
    label,
    onSave,
}: SaveMainButtonOptions): void => {
    useMainButton({
        text: label,
        visible: writable && dirty,
        enabled: valid && !saving,
        progress: saving,
        onClick: onSave,
    });
};
