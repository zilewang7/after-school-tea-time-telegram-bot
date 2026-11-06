import { NavListItem } from '../../components/nav-list-item';
import { useMe } from '../../context/me-context';
import { userDisplayName } from '../../format';
import { ChatListItem } from './chat-list-item';

const OwnerEntries = () => (
    <section className="section">
        <h2 className="section-title">全局</h2>
        <ul className="list">
            <NavListItem to="/global" label="全局设置" />
            <NavListItem to="/audit" label="全部设置改动" />
        </ul>
    </section>
);

export const ChatListPage = () => {
    const { me } = useMe();
    // The start link pointed at a chat this user cannot open; the server already resolved that
    const startDenied = me.startTarget !== null && me.startTarget.access === 'none';

    return (
        <>
            <header className="page-header">
                <h1>控制面板</h1>
                <p className="hint">
                    {userDisplayName(me.user)}
                    {me.isOwner ? ' · 机主' : ''}
                </p>
            </header>
            {startDenied && <p className="notice warning">你不是该聊天的成员</p>}
            {me.isOwner && <OwnerEntries />}
            <section className="section">
                <h2 className="section-title">聊天</h2>
                {me.chats.length === 0 ? (
                    <p className="placeholder">还没有可以查看的聊天。在群里发 /panel 可以从群里打开面板。</p>
                ) : (
                    <ul className="list">
                        {me.chats.map((chat) => (
                            <ChatListItem key={chat.chatId} chat={chat} globalDefaultModel={me.globalDefaultModel} />
                        ))}
                    </ul>
                )}
            </section>
        </>
    );
};
