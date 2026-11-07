import { useMemo } from 'react';
import { useChatScope } from '../../context/chat-scope-context';
import { useMe } from '../../context/me-context';
import { chatLabelOf } from '../../format';
import { AuditPage } from './audit-page';

/** /c/:chatId/settings/audit */
export const ChatAuditRoute = () => {
    const { chatId, header } = useChatScope();
    const subtitle = useMemo(() => (header === null ? '本聊天' : chatLabelOf(header.name)), [header]);
    return <AuditPage key={chatId} chatId={chatId} subtitle={subtitle} />;
};

/** /settings/audit (owner only) */
export const GlobalAuditRoute = () => {
    const { me } = useMe();
    if (!me.isOwner) return <p className="placeholder">仅机主可以查看全部设置改动</p>;
    return <AuditPage chatId={null} subtitle="全部聊天与全局" />;
};
