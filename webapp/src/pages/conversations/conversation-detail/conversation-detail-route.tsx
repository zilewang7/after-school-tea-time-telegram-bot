import { useCallback, useEffect, useMemo, useState } from 'react';
import { match } from 'ts-pattern';
import { ErrorView, LoadingView } from '../../../components/status-views';
import { useChatScope } from '../../../context/chat-scope-context';
import { useMe } from '../../../context/me-context';
import { useApi } from '../../../context/panel-context';
import { chatNameOf, formatDateTime } from '../../../format';
import { useApiQuery } from '../../../hooks/use-api-query';
import { useChatIdParam } from '../../../hooks/use-chat-id-param';
import { useRootIdParam } from '../../../hooks/use-message-id-param';
import { usePolling } from '../../../hooks/use-polling';
import { ShareBar } from '../../../share/share-bar';
import type { ShareTarget } from '../../../share/share-link';
import { NotFoundPage } from '../../not-found-page';
import { ConversationDetailView } from './conversation-detail-view';
import type { ConversationSegment } from './conversation-detail-view';

interface ConversationDetailPageProps {
    chatId: number;
    rootId: number;
}

const ConversationDetailPage = ({ chatId, rootId }: ConversationDetailPageProps) => {
    const api = useApi();
    const { me } = useMe();
    const { detail, header } = useChatScope();
    const loadTree = useCallback(
        (signal: AbortSignal) => api.getConversationTree(chatId, rootId, signal),
        [api, chatId, rootId]
    );
    const { state, reload, refresh } = useApiQuery(loadTree);
    const tree = state.status === 'success' ? state.data : null;
    // A generating conversation keeps the tree fresh (design §5)
    usePolling(refresh, tree?.generating ?? false);

    const [segment, setSegment] = useState<ConversationSegment>('tree');
    const member = tree?.access === 'member';
    // Observers have no model view; leaving the chat cannot keep it selected (统计 stays available)
    useEffect(() => {
        if (tree !== null && !member && segment === 'model') setSegment('tree');
    }, [tree, member, segment]);

    const title = useMemo(() => {
        const rootNode = tree?.nodes.find((node) => node.messageId === tree.rootId);
        return rootNode === undefined ? '会话' : `会话 · ${formatDateTime(rootNode.date)}`;
    }, [tree]);

    const chatModel = useMemo(() => {
        if (detail.state.status === 'success') return detail.state.data.effectiveModel;
        const summary = me.chats.find((chat) => chat.chatId === chatId);
        return summary?.model ?? null;
    }, [detail.state, me.chats, chatId]);

    const handleChanged = useCallback(() => refresh(), [refresh]);

    const chatName = useMemo(
        () => (header === null ? `聊天 ${chatId}` : chatNameOf(header.name)),
        [header, chatId]
    );
    // Members only: the server refuses a conversation share from observers
    const shareTarget = useMemo<ShareTarget>(
        () => ({ kind: 'conversation', chatId, rootId }),
        [chatId, rootId]
    );

    return (
        <>
            <header className="page-header">
                <h1>{title}</h1>
                {tree !== null && tree.generating && <p className="hint">正在生成…</p>}
                {member && (
                    <ShareBar
                        target={shareTarget}
                        chatName={chatName}
                        versionLabel={null}
                        confirmMessage="链接公开，任何拿到链接的人都能查看这段对话"
                    />
                )}
            </header>
            {match(state)
                .with({ status: 'loading' }, () => <LoadingView />)
                .with({ status: 'error' }, ({ failure }) => <ErrorView failure={failure} onRetry={reload} />)
                .with({ status: 'success' }, ({ data }) => (
                    <ConversationDetailView
                        chatId={chatId}
                        tree={data}
                        segment={segment}
                        onSegmentChange={setSegment}
                        onChanged={handleChanged}
                        models={me.models}
                        chatModel={chatModel}
                    />
                ))
                .exhaustive()}
        </>
    );
};

/** /c/:chatId/conv/:rootId */
export const ConversationDetailRoute = () => {
    const chatId = useChatIdParam();
    const rootId = useRootIdParam();
    if (chatId === null || rootId === null) return <NotFoundPage />;
    // Keyed so moving between conversations starts from a clean state
    return <ConversationDetailPage key={`${chatId}:${rootId}`} chatId={chatId} rootId={rootId} />;
};
