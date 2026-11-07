import { Link } from 'react-router';
import type { ChatSummary } from '../../api';
import { ChatName } from '../../components/chat-name';
import { accessLabel, chatTypeLabel, formatDateTime } from '../../format';
import { chatPath } from '../../routing/paths';

interface ChatListItemProps {
    chat: ChatSummary;
    globalDefaultModel: string;
}

export const ChatListItem = ({ chat, globalDefaultModel }: ChatListItemProps) => {
    const followsGlobal = chat.modelSource === 'global';
    const modelText = `${chat.model ?? globalDefaultModel} · ${followsGlobal ? '跟随全局' : '本聊天设置'}`;

    return (
        <li>
            {/* "/c/:id" opens the chat's remembered or default tab */}
            <Link className="list-link" to={chatPath(chat.chatId)}>
                <span className="list-title">
                    <span className="truncate">
                        <ChatName chat={chat} />
                    </span>
                    <span className="chevron" aria-hidden="true">
                        ›
                    </span>
                </span>
                <span className="badges">
                    <span className="badge">{chatTypeLabel(chat.type)}</span>
                    <span className={chat.access === 'member' ? 'badge' : 'badge accent'}>{accessLabel(chat.access)}</span>
                    {chat.paused && <span className="badge warning">已暂停</span>}
                    {chat.settingsLocked && <span className="badge">已锁定</span>}
                    {chat.openIssues > 0 && <span className="badge warning">{chat.openIssues} 个未关闭 issue</span>}
                </span>
                <span className="hint truncate">{modelText}</span>
                {chat.lastActivityAt !== null && (
                    <span className="hint">最近活动 {formatDateTime(chat.lastActivityAt)}</span>
                )}
            </Link>
        </li>
    );
};
