import type { ReactNode } from 'react';

interface CollapsibleSectionProps {
    title: string;
    // Short right-aligned line in the summary, e.g. a size or a count
    summary: string | null;
    // Starts open (e.g. an error that should not be missed)
    open?: boolean;
    children: ReactNode;
}

/** A folded block (thinking, tool records, the static head): tap the summary to see it */
export const CollapsibleSection = ({ title, summary, open = false, children }: CollapsibleSectionProps) => (
    <details className="collapsible" open={open}>
        <summary className="collapsible-summary">
            <span>{title}</span>
            {summary !== null && <span className="hint">{summary}</span>}
        </summary>
        <div className="collapsible-body">{children}</div>
    </details>
);
