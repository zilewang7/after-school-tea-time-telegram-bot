import { useCallback, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import { match } from 'ts-pattern';
import type { StartTarget } from '../../api';
import { useMe } from '../../context/me-context';
import { ChatListItem } from './chat-list-item';
import { CHAT_SEARCH_THRESHOLD, filterChats } from './chat-search';

/** What to say when a chat start link could not be followed; the server already resolved it */
const startNoticeOf = (startTarget: StartTarget | null): string | null =>
    match(startTarget)
        .with({ kind: 'chat', access: 'unavailable' }, () => '暂时无法确认你是否是该聊天的成员，请稍后再试')
        .with({ kind: 'chat', access: 'none' }, () => '你不是该聊天的成员')
        // Issue links always open the issue page, which explains a hidden issue itself
        .otherwise(() => null);

/** "/" (home tab 聊天): every chat this user can open, most recently active first */
export const ChatListPage = () => {
    const { me } = useMe();
    const startNotice = useMemo(() => startNoticeOf(me.startTarget), [me.startTarget]);
    const [query, setQuery] = useState('');
    const searchable = me.chats.length > CHAT_SEARCH_THRESHOLD;
    const shownChats = useMemo(() => (searchable ? filterChats(me.chats, query) : me.chats), [searchable, me.chats, query]);

    const handleQueryChange = useCallback((event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value), []);

    return (
        <>
            {startNotice !== null && <p className="notice warning">{startNotice}</p>}
            <section className="section">
                {searchable && (
                    <input
                        className="field"
                        type="search"
                        value={query}
                        placeholder="搜索聊天：名字、@username 或 id"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        aria-label="搜索聊天"
                        onChange={handleQueryChange}
                    />
                )}
                {me.chats.length === 0 && (
                    <p className="placeholder">还没有可以查看的聊天。在群里发 /panel 可以从群里打开面板。</p>
                )}
                {me.chats.length > 0 && shownChats.length === 0 && <p className="placeholder">没有匹配的聊天</p>}
                {shownChats.length > 0 && (
                    <ul className="list">
                        {shownChats.map((chat) => (
                            <ChatListItem key={chat.chatId} chat={chat} globalDefaultModel={me.globalDefaultModel} />
                        ))}
                    </ul>
                )}
            </section>
        </>
    );
};
