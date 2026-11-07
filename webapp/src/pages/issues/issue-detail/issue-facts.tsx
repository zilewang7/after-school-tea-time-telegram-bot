import { Link } from 'react-router';
import type { IssueChat, IssueChatAccess, IssueDetail } from '../../../api';
import { ChatName } from '../../../components/chat-name';
import { formatDateTime } from '../../../format';
import { issueSourceLabel } from '../../../issues/issue-labels';
import { chatPath } from '../../../routing/paths';

// Only these open the chat; the owner may see issues of chats that stay closed to them
const OPENABLE_CHAT_ACCESS: ReadonlySet<IssueChatAccess> = new Set(['member', 'observer']);

interface IssueChatLinkProps {
    chat: IssueChat | null;
    chatAccess: IssueChatAccess | null;
}

const IssueChatLink = ({ chat, chatAccess }: IssueChatLinkProps) => {
    if (chat === null) return <span className="hint">无</span>;
    if (chatAccess === null || !OPENABLE_CHAT_ACCESS.has(chatAccess)) return <ChatName chat={chat} />;
    return (
        <Link to={chatPath(chat.chatId)}>
            <ChatName chat={chat} />
        </Link>
    );
};

interface IssueFactsProps {
    issue: IssueDetail;
}

/** Where it came from, who filed it and when */
export const IssueFacts = ({ issue }: IssueFactsProps) => (
    <section className="section">
        <dl className="facts">
            <dt>来源聊天</dt>
            <dd>
                <IssueChatLink chat={issue.chat} chatAccess={issue.chatAccess} />
            </dd>
            <dt>来源</dt>
            <dd>{issueSourceLabel(issue.source)}</dd>
            {issue.createdBy !== null && (
                <>
                    <dt>提交者</dt>
                    <dd>{issue.createdBy.name}</dd>
                </>
            )}
            {issue.toolName !== null && (
                <>
                    <dt>相关工具</dt>
                    <dd className="tool-name">{issue.toolName}</dd>
                </>
            )}
            <dt>创建于</dt>
            <dd>{formatDateTime(issue.createdAt)}</dd>
            <dt>更新于</dt>
            <dd>{formatDateTime(issue.updatedAt)}</dd>
        </dl>
    </section>
);
