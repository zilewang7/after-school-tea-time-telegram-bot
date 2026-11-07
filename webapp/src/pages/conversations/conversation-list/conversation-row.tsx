import { useMemo } from 'react';
import { Link } from 'react-router';
import type { ConversationListItem, ConversationRoot } from '../../../api';
import { formatDateTime } from '../../../format';
import { conversationPath } from '../../../routing/paths';

interface RootTitleProps {
    root: ConversationRoot;
}

/** The first line of a conversation row: who and what started it, or the observer's placeholder */
const RootTitle = ({ root }: RootTitleProps) => {
    const title = useMemo(() => {
        if (root.kind === 'bot') return root.excerpt === '' ? 'bot 消息' : root.excerpt;
        if (root.redacted) return '用户消息';
        return `${root.author.name}：${root.excerpt === '' ? '（无正文）' : root.excerpt}`;
    }, [root]);
    return <span className="list-title-main truncate">{title}</span>;
};

interface ConversationRowProps {
    chatId: number;
    item: ConversationListItem;
}

/** "Mio：…", then "14 条消息 · 3 次回复 · argon · 14:05" with the error / generating markers */
export const ConversationRow = ({ chatId, item }: ConversationRowProps) => {
    const meta = useMemo(
        () =>
            [
                `${item.messageCount} 条消息`,
                `${item.replyCount} 次回复`,
                item.lastModel ?? null,
                formatDateTime(item.lastActivityAt),
            ]
                .filter((part): part is string => part !== null)
                .join(' · '),
        [item]
    );

    return (
        <li>
            <Link className="list-link" to={conversationPath(chatId, item.rootId)}>
                <span className="list-title">
                    <RootTitle root={item.root} />
                    <span className="badges">
                        {item.hasError && <span className="badge warning">⚠</span>}
                        {item.generating && <span className="badge accent">生成中</span>}
                        <span className="chevron" aria-hidden="true">
                            ›
                        </span>
                    </span>
                </span>
                <span className="hint">{meta}</span>
            </Link>
        </li>
    );
};
