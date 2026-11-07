import { useCallback } from 'react';
import { match } from 'ts-pattern';
import { ErrorView, LoadingView } from '../../../components/status-views';
import { useApi } from '../../../context/panel-context';
import { useApiQuery } from '../../../hooks/use-api-query';
import { useChatIdParam } from '../../../hooks/use-chat-id-param';
import { useFirstMessageIdParam } from '../../../hooks/use-message-id-param';
import { NotFoundPage } from '../../not-found-page';
import { ReplyDetailView } from './reply-detail-view';

interface ReplyDetailPageProps {
    chatId: number;
    firstMessageId: number;
}

const ReplyDetailPage = ({ chatId, firstMessageId }: ReplyDetailPageProps) => {
    const api = useApi();
    const loadReply = useCallback(
        (signal: AbortSignal) => api.getReply(chatId, firstMessageId, signal),
        [api, chatId, firstMessageId]
    );
    const { state, reload } = useApiQuery(loadReply);

    return (
        <>
            <header className="page-header">
                <h1>回复 · #{firstMessageId}</h1>
            </header>
            {match(state)
                .with({ status: 'loading' }, () => <LoadingView />)
                .with({ status: 'error' }, ({ failure }) => <ErrorView failure={failure} onRetry={reload} />)
                .with({ status: 'success' }, ({ data }) => (
                    <ReplyDetailView chatId={chatId} reply={data} />
                ))
                .exhaustive()}
        </>
    );
};

/** /c/:chatId/replies/:firstMessageId */
export const ReplyDetailRoute = () => {
    const chatId = useChatIdParam();
    const firstMessageId = useFirstMessageIdParam();
    if (chatId === null || firstMessageId === null) return <NotFoundPage />;
    // Keyed so moving between replies starts from a clean state
    return <ReplyDetailPage key={`${chatId}:${firstMessageId}`} chatId={chatId} firstMessageId={firstMessageId} />;
};
