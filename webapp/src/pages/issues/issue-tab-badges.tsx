import { useMemo } from 'react';
import { TabCount } from '../../components/tab-count';
import { useChatScope } from '../../context/chat-scope-context';
import { useMe } from '../../context/me-context';

/** Open issues of the chat, from /api/me */
export const ChatOpenIssuesBadge = () => {
    const { summary } = useChatScope();
    return <TabCount count={summary?.openIssues ?? 0} />;
};

/** Open issues across the chats in /api/me (issues filed on no chat are not counted there) */
export const HomeOpenIssuesBadge = () => {
    const { me } = useMe();
    const count = useMemo(() => me.chats.reduce((total, chat) => total + chat.openIssues, 0), [me.chats]);
    return <TabCount count={count} />;
};
