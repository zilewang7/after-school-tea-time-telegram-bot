import { useMemo } from 'react';
import { match } from 'ts-pattern';
import type { StartTarget } from '../../api';
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

/** What to say when the start link could not be followed; the server already resolved it */
const startNoticeOf = (startTarget: StartTarget | null): string | null =>
    match(startTarget)
        .with({ access: 'unavailable' }, () => '暂时无法确认你是否是该聊天的成员，请稍后再试')
        .with({ kind: 'issue', access: 'none' }, () => '该 issue 不存在或你无权查看')
        .with({ kind: 'chat', access: 'none' }, () => '你不是该聊天的成员')
        .otherwise(() => null);

export const ChatListPage = () => {
    const { me } = useMe();
    const startNotice = useMemo(() => startNoticeOf(me.startTarget), [me.startTarget]);

    return (
        <>
            <header className="page-header">
                <h1>控制面板</h1>
                <p className="hint">
                    {userDisplayName(me.user)}
                    {me.isOwner ? ' · 机主' : ''}
                </p>
            </header>
            {startNotice !== null && <p className="notice warning">{startNotice}</p>}
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
