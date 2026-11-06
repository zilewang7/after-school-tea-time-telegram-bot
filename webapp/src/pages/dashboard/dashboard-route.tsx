import { useChatIdParam } from '../../hooks/use-chat-id-param';
import { NotFoundPage } from '../not-found-page';
import { DashboardPage } from './dashboard-page';

export const DashboardRoute = () => {
    const chatId = useChatIdParam();
    if (chatId === null) return <NotFoundPage />;
    // Keyed so switching chats starts from a clean state
    return <DashboardPage key={chatId} chatId={chatId} />;
};
