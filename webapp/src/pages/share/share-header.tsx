import { formatDateTime } from '../../format';

interface ShareHeaderProps {
    chatTitle: string | null;
    // When the share was created
    createdAt: string;
}

/** Who the content belongs to: the bot, the chat's name and the share's time */
export const ShareHeader = ({ chatTitle, createdAt }: ShareHeaderProps) => (
    <header className="share-header">
        <span className="share-brand">k-on-bot</span>
        {chatTitle !== null && <span className="share-chat-title">{chatTitle}</span>}
        <span className="hint">{formatDateTime(createdAt)}</span>
    </header>
);
