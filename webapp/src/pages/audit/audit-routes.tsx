import { useMe } from '../../context/me-context';
import { useChatIdParam } from '../../hooks/use-chat-id-param';
import { NotFoundPage } from '../not-found-page';
import { AuditPage } from './audit-page';

/** /c/:chatId/audit */
export const ChatAuditRoute = () => {
    const chatId = useChatIdParam();
    if (chatId === null) return <NotFoundPage />;
    return <AuditPage key={chatId} chatId={chatId} />;
};

/** /audit (owner only) */
export const GlobalAuditRoute = () => {
    const { me } = useMe();
    if (!me.isOwner) return <p className="placeholder">仅机主可以查看全部设置改动</p>;
    return <AuditPage chatId={null} />;
};
