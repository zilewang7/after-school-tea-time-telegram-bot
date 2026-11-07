import { useMemo } from 'react';
import { Link } from 'react-router';
import type { ActiveReply } from '../../../api';
import { formatElapsed, replyPhaseLabel } from '../../../format-metrics';
import { useNow } from '../../../hooks/use-now';
import { replyPath } from '../../../routing/paths';

interface GeneratingRowProps {
    reply: ActiveReply;
    now: number;
}

const GeneratingRow = ({ reply, now }: GeneratingRowProps) => {
    const elapsed = useMemo(
        () => formatElapsed(now - Date.parse(reply.startedAt)),
        [now, reply.startedAt]
    );
    const detail = reply.statusLine ?? replyPhaseLabel(reply.phase);
    return (
        <li className="generating-row">
            <div className="generating-main">
                <p className="list-title">
                    <span className="generating-dot" aria-hidden="true" />
                    <span className="truncate">
                        正在生成 · {reply.model} · {elapsed}
                    </span>
                </p>
                <p className="hint truncate">{detail}</p>
            </div>
            <Link className="button secondary" to={replyPath(reply.chat.chatId, reply.firstMessageId)}>
                查看
            </Link>
        </li>
    );
};

interface GeneratingBannerProps {
    replies: readonly ActiveReply[];
}

/** The 「正在生成」 banner on top of the conversation list; one line per live reply */
export const GeneratingBanner = ({ replies }: GeneratingBannerProps) => {
    const now = useNow(1000);
    return (
        <section className="section generating-banner" aria-live="polite">
            <ul className="list">
                {replies.map((reply) => (
                    <GeneratingRow key={`${reply.chat.chatId}:${reply.firstMessageId}`} reply={reply} now={now} />
                ))}
            </ul>
        </section>
    );
};
