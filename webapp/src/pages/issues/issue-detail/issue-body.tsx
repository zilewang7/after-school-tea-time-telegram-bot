import { useCallback, useMemo, useState } from 'react';

// Past either limit the body starts folded
const FOLD_LINE_COUNT = 12;
const FOLD_CHAR_COUNT = 600;

const isLongText = (text: string): boolean => text.length > FOLD_CHAR_COUNT || text.split('\n').length > FOLD_LINE_COUNT;

interface IssueBodyProps {
    text: string;
}

/** The issue text as written; long text starts folded */
export const IssueBody = ({ text }: IssueBodyProps) => {
    const long = useMemo(() => isLongText(text), [text]);
    const [expanded, setExpanded] = useState(false);
    const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);
    const folded = long && !expanded;

    return (
        <>
            <p className={folded ? 'prewrap folded' : 'prewrap'}>{text}</p>
            {long && (
                <button type="button" className="button secondary" aria-expanded={expanded} onClick={toggleExpanded}>
                    {expanded ? '收起' : '展开全文'}
                </button>
            )}
        </>
    );
};
