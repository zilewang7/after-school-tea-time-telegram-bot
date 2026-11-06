import { useMemo } from 'react';
import type { ChatAuditEntry } from '../../api';
import { AuditEntryItem } from '../../components/audit-entry-item';
import { NavListItem } from '../../components/nav-list-item';

const RECENT_AUDIT_COUNT = 5;

interface RecentAuditProps {
    chatId: number;
    entries: readonly ChatAuditEntry[];
}

export const RecentAudit = ({ chatId, entries }: RecentAuditProps) => {
    const recentEntries = useMemo(() => entries.slice(0, RECENT_AUDIT_COUNT), [entries]);

    return (
        <section className="section">
            <h2 className="section-title">最近修改</h2>
            {recentEntries.length === 0 ? (
                <p className="placeholder">还没有设置改动</p>
            ) : (
                <ul className="list">
                    {recentEntries.map((entry) => (
                        <AuditEntryItem key={entry.id} entry={entry} scopeLabel={null} showChange={false} />
                    ))}
                </ul>
            )}
            <ul className="list">
                <NavListItem to={`/c/${chatId}/audit`} label="本聊天全部设置改动" />
            </ul>
        </section>
    );
};
