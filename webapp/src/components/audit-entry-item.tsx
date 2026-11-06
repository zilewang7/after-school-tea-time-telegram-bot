import { useMemo } from 'react';
import type { ChatAuditEntry } from '../api';
import { auditKeyLabel, formatAuditValue, formatDateTime } from '../format';

const INLINE_VALUE_MAX_LENGTH = 40;

const fitsInline = (text: string): boolean => text.length <= INLINE_VALUE_MAX_LENGTH && !text.includes('\n');

interface AuditChangeProps {
    entry: ChatAuditEntry;
}

/** Old -> new value; long or multi-line values (e.g. the addendum) are folded */
const AuditChange = ({ entry }: AuditChangeProps) => {
    const oldText = useMemo(() => formatAuditValue(entry.key, entry.oldValue), [entry.key, entry.oldValue]);
    const newText = useMemo(() => formatAuditValue(entry.key, entry.newValue), [entry.key, entry.newValue]);

    if (fitsInline(oldText) && fitsInline(newText)) {
        return (
            <p className="audit-change">
                {oldText} → {newText}
            </p>
        );
    }
    return (
        <details className="audit-change">
            <summary>查看改动</summary>
            <p className="hint">改前</p>
            <pre className="code-block">{oldText}</pre>
            <p className="hint">改后</p>
            <pre className="code-block">{newText}</pre>
        </details>
    );
};

interface AuditEntryItemProps {
    entry: ChatAuditEntry;
    // Where the change happened; only shown in the global audit view
    scopeLabel: string | null;
    showChange: boolean;
}

export const AuditEntryItem = ({ entry, scopeLabel, showChange }: AuditEntryItemProps) => (
    <li className="audit-entry">
        {scopeLabel !== null && <p className="hint">{scopeLabel}</p>}
        <p>
            {entry.actorName} · {formatDateTime(entry.createdAt)} · 改了{auditKeyLabel(entry.key)}
        </p>
        {showChange && <AuditChange entry={entry} />}
    </li>
);
