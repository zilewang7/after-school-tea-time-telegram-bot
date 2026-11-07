interface ReplyVersionPickerProps {
    // 1-based version numbers
    versionNumbers: readonly number[];
    // 1-based; null when no version is stored
    selected: number | null;
    // The version the reply currently shows, marked in the row
    current: number | null;
    onSelect: (versionNumber: number) => void;
}

/** Horizontal v1 / v2 / … chips; the current version is marked */
export const ReplyVersionPicker = ({ versionNumbers, selected, current, onSelect }: ReplyVersionPickerProps) => {
    if (versionNumbers.length === 0) return null;
    return (
        <div className="chips" role="tablist" aria-label="回复版本">
            {versionNumbers.map((versionNumber) => (
                <button
                    key={versionNumber}
                    type="button"
                    role="tab"
                    aria-selected={versionNumber === selected}
                    className="chip"
                    onClick={() => onSelect(versionNumber)}
                >
                    v{versionNumber}
                    {versionNumber === current ? '（当前）' : ''}
                </button>
            ))}
        </div>
    );
};
