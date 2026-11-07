import { useEffect, useMemo } from 'react';
import { useChatScope } from '../../../context/chat-scope-context';
import { ConversationListView } from './conversation-list-view';
import { GeneratingBanner } from './generating-banner';
import { useActiveReplies } from './use-active-replies';
import { useConversationList } from './use-conversation-list';

/** /c/:chatId/conv: the last 7 days of conversations, with the live reply banner */
export const ChatConversationsTab = () => {
    const { chatId } = useChatScope();
    const { state, loadMore, retry, reload } = useConversationList(chatId);

    // Only a list that says something is generating starts polling (design §5)
    const generating = useMemo(
        () => state.data?.conversations.some((item) => item.generating) ?? false,
        [state.data]
    );
    const { active, finished } = useActiveReplies(chatId, generating);

    // The last live reply landed: the new rows are in the list now
    useEffect(() => {
        if (finished) reload();
    }, [finished, reload]);

    return (
        <>
            {active.length > 0 && <GeneratingBanner replies={active} />}
            <section className="section">
                <ConversationListView chatId={chatId} state={state} onLoadMore={loadMore} onRetry={retry} />
            </section>
        </>
    );
};
