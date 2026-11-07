import { useCallback } from 'react';
import { match } from 'ts-pattern';
import { ErrorView, LoadingView } from '../../../components/status-views';
import { useApi } from '../../../context/panel-context';
import { useApiQuery } from '../../../hooks/use-api-query';
import { StatsView } from '../../stats/stats-view';

interface ConversationStatsPanelProps {
    chatId: number;
    rootId: number;
}

/**
 * The conversation's statistics: the same blocks as the chat statistics page,
 * restricted to the replies of this tree (its whole life, so no range picker).
 */
export const ConversationStatsPanel = ({ chatId, rootId }: ConversationStatsPanelProps) => {
    const api = useApi();
    const load = useCallback(
        (signal: AbortSignal) => api.getConversationStats(chatId, rootId, signal),
        [api, chatId, rootId]
    );
    const { state, reload } = useApiQuery(load);

    return match(state)
        .with({ status: 'loading' }, () => <LoadingView />)
        .with({ status: 'error' }, ({ failure }) => <ErrorView failure={failure} onRetry={reload} />)
        .with({ status: 'success' }, ({ data }) => <StatsView data={data} refreshing={false} />)
        .exhaustive();
};
