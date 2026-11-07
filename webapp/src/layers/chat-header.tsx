import { ChatName } from '../components/chat-name';
import { accessLabel, chatTypeLabel } from '../format';
import type { ChatHeaderInfo } from './chat-header-info';

interface ChatBadgesProps {
    header: ChatHeaderInfo;
}

const ChatBadges = ({ header }: ChatBadgesProps) => (
    <p className="badges">
        <span className="badge">{chatTypeLabel(header.type)}</span>
        <span className={header.access === 'member' ? 'badge' : 'badge accent'}>{accessLabel(header.access)}</span>
        {header.paused && <span className="badge warning">已暂停</span>}
        {header.locked && <span className="badge">已锁定</span>}
    </p>
);

interface ChatHeaderProps {
    // null while neither /api/me nor the chat's detail knows the chat
    header: ChatHeaderInfo | null;
}

/** Chat name with its @username, then type · access · paused · locked; scrolls away above the tab bar */
export const ChatHeader = ({ header }: ChatHeaderProps) => (
    <header className="layer-header">
        {header === null ? (
            <h1>聊天</h1>
        ) : (
            <>
                <h1 className="truncate">
                    <ChatName chat={header.name} />
                </h1>
                <ChatBadges header={header} />
            </>
        )}
    </header>
);
