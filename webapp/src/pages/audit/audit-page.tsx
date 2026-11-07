import { useCallback } from 'react';
import { match } from 'ts-pattern';
import { ErrorView, LoadingView } from '../../components/status-views';
import { useMe } from '../../context/me-context';
import { useApi } from '../../context/panel-context';
import { useApiQuery } from '../../hooks/use-api-query';
import { AuditList } from './audit-list';

interface AuditPageProps {
    // null = all settings changes (owner only)
    chatId: number | null;
    // Which chat (or "all") the list covers
    subtitle: string;
}

export const AuditPage = ({ chatId, subtitle }: AuditPageProps) => {
    const api = useApi();
    const { me } = useMe();
    const loadFirstPage = useCallback(
        (signal: AbortSignal) => api.getAudit({ chatId, beforeId: null }, signal),
        [api, chatId]
    );
    const { state, reload } = useApiQuery(loadFirstPage);

    return (
        <>
            <header className="page-header">
                <h1>{chatId === null ? '全部设置改动' : '设置改动'}</h1>
                <p className="hint">{subtitle}</p>
            </header>
            <section className="section">
                {match(state)
                    .with({ status: 'loading' }, () => <LoadingView />)
                    .with({ status: 'error' }, ({ failure }) => <ErrorView failure={failure} onRetry={reload} />)
                    .with({ status: 'success' }, ({ data }) => (
                        <AuditList chatId={chatId} firstPage={data.entries} chats={me.chats} />
                    ))
                    .exhaustive()}
            </section>
        </>
    );
};
