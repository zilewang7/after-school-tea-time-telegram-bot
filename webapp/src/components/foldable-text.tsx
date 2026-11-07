import { useCallback, useMemo, useState } from 'react';

const DEFAULT_FOLD_LINES = 6;
const DEFAULT_FOLD_CHARS = 400;

const isLongText = (text: string, foldLines: number, foldChars: number): boolean =>
    text.length > foldChars || text.split('\n').length > foldLines;

interface FoldableTextProps {
    text: string;
    // Text with more lines (or characters) starts folded
    foldLines?: number;
    foldChars?: number;
    className?: string;
}

/** Plain text with newlines kept; long text starts folded behind 「展开全文」 */
export const FoldableText = ({
    text,
    foldLines = DEFAULT_FOLD_LINES,
    foldChars = DEFAULT_FOLD_CHARS,
    className = 'prewrap',
}: FoldableTextProps) => {
    const long = useMemo(() => isLongText(text, foldLines, foldChars), [text, foldLines, foldChars]);
    const [expanded, setExpanded] = useState(false);
    const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);
    const folded = long && !expanded;

    return (
        <>
            <p className={folded ? `${className} folded` : className}>{text}</p>
            {long && (
                <button type="button" className="button secondary" aria-expanded={expanded} onClick={toggleExpanded}>
                    {expanded ? '收起' : '展开全文'}
                </button>
            )}
        </>
    );
};
