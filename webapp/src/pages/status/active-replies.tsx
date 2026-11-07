import { useMemo } from 'react';
import { Link } from 'react-router';
import type { ActiveReply } from '../../api';
import { ChatName } from '../../components/chat-name';
import { formatElapsed, replyPhaseLabel } from '../../format-metrics';
import { useNow } from '../../hooks/use-now';
import { chatPath, replyPath } from '../../routing/paths';

interface ActiveReplyRowProps {
    reply: ActiveReply;
    now: number;
}

const ActiveReplyRow = ({ reply, now }: ActiveReplyRowProps) => {
    const elapsed = useMemo(
        () => formatElapsed(now - Date.parse(reply.startedAt)),
        [now, reply.startedAt]
    );
    return (
        <li className="status-row">
            <div className="list-title">
                <Link className="truncate" to={chatPath(reply.chat.chatId)}>
                    <ChatName chat={reply.chat} />
                </Link>
                <Link className="button secondary" to={replyPath(reply.chat.chatId, reply.firstMessageId)}>
                    查看
                </Link>
            </div>
            <p className="hint">
                {reply.model} · {elapsed} · {replyPhaseLabel(reply.phase)}
                {reply.isRetry ? ' · 重试' : ''}
            </p>
            {reply.statusLine !== null && <p className="hint truncate">{reply.statusLine}</p>}
            {reply.trigger !== null && (
                <p className="hint truncate">
                    {reply.trigger.authorName}：{reply.trigger.text}
                </p>
            )}
        </li>
    );
};

interface ActiveRepliesProps {
    replies: readonly ActiveReply[];
}

/** The replies being generated right now, longest running first */
export const ActiveReplies = ({ replies }: ActiveRepliesProps) => {
    // One clock for every row, so the elapsed counters tick together
    const now = useNow(1000);
    return (
        <section className="section">
            <h2 className="section-title">正在生成（{replies.length}）</h2>
            {replies.length === 0 ? (
                <p className="hint">现在没有正在生成的回复</p>
            ) : (
                <ul className="list">
                    {replies.map((reply) => (
                        <ActiveReplyRow
                            key={`${reply.chat.chatId}:${reply.firstMessageId}`}
                            reply={reply}
                            now={now}
                        />
                    ))}
                </ul>
            )}
        </section>
    );
};
