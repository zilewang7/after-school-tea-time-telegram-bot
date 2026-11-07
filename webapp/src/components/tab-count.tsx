const MAX_SHOWN_COUNT = 99;

interface TabCountProps {
    count: number;
}

/** Small count pill after a tab's label; nothing for zero */
export const TabCount = ({ count }: TabCountProps) => {
    if (count <= 0) return null;
    return <span className="tab-count">{count > MAX_SHOWN_COUNT ? `${MAX_SHOWN_COUNT}+` : count}</span>;
};
