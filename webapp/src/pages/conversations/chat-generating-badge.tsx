import { useSyncExternalStore } from 'react';
import { useChatScope } from '../../context/chat-scope-context';
import { readGeneratingChatIds, subscribeGeneratingChatIds } from './conversation-list/generating-store';

/** A dot on the 会话 tab while a reply of this chat is being generated */
export const ChatGeneratingBadge = () => {
    const { chatId } = useChatScope();
    const generatingChatIds = useSyncExternalStore(subscribeGeneratingChatIds, readGeneratingChatIds);
    if (!generatingChatIds.has(chatId)) return null;
    return <span className="tab-dot" aria-label="有回复正在生成" />;
};
