import { useCallback, useMemo } from 'react';
import { match } from 'ts-pattern';
import { ErrorView, LoadingView } from '../../components/status-views';
import { useMe } from '../../context/me-context';
import { useApi } from '../../context/panel-context';
import { chatTitleOf } from '../../format';
import { useApiQuery } from '../../hooks/use-api-query';
import { AuditList } from './audit-list';

interface AuditPageProps {
    // null = all settings changes (owner only)
    chatId: number | null;
}

export const AuditPage = ({ chatId }: AuditPageProps) => {
    const api = useApi();
    const { me } = useMe();
    const loadFirstPage = useCallback(
        (signal: AbortSignal) => api.getAudit({ chatId, beforeId: null }, signal),
        [api, chatId]
    );
    const { state, reload } = useApiQuery(loadFirstPage);

    const subtitle = useMemo(() => {
        if (chatId === null) return '全部聊天与全局';
        const chat = me.chats.find((candidate) => candidate.chatId === chatId);
        return chatTitleOf(chat?.title ?? null, chatId);
    }, [chatId, me.chats]);

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
