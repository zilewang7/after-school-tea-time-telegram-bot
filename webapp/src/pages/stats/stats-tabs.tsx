import { useChatScope } from '../../context/chat-scope-context';
import { StatsPage } from './stats-page';

/** /c/:chatId/stats: this chat's replies, errors, tools and cost estimate */
export const ChatStatsTab = () => {
    const { chatId } = useChatScope();
    return <StatsPage chatId={chatId} />;
};

/** /stats (owner): the same blocks across every chat, plus the chat ranking */
export const HomeStatsTab = () => <StatsPage chatId={null} />;
