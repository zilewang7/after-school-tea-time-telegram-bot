import { Link } from 'react-router';
import { ChatName } from '../../../components/chat-name';
import { useMe } from '../../../context/me-context';
import { chatTypeLabel } from '../../../format';
import { chatIssueNewPath } from '../../../routing/paths';

/**
 * /issues/new: the home issue list has no chat scope, and the form is
 * chat-scoped, so this page picks the chat first.
 */
export const IssueNewChatPickerPage = () => {
    const { me } = useMe();

    return (
        <>
            <header className="page-header">
                <h1>提 issue</h1>
                <p className="hint">选择要提 issue 的聊天</p>
            </header>
            <section className="section">
                {me.chats.length === 0 ? (
                    <p className="placeholder">没有可以提 issue 的聊天</p>
                ) : (
                    <ul className="list">
                        {me.chats.map((chat) => (
                            <li key={chat.chatId}>
                                <Link className="list-link" to={chatIssueNewPath(chat.chatId)}>
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
                                    </span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </>
    );
};
