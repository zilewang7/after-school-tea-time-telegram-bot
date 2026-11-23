import type { PublicShareReaction } from '../../api';

interface ShareReactionsProps {
    // The message's reaction pills, in server order; empty renders nothing
    reactions: readonly PublicShareReaction[];
}

/** Telegram-style reaction pills under a share page's message: emoji + count */
export const ShareReactions = ({ reactions }: ShareReactionsProps) => {
    if (reactions.length === 0) return null;
    return (
        <div className="share-reactions">
            {reactions.map((reaction) => (
                <span key={reaction.emoji} className="share-reaction">
                    <span className="share-reaction-emoji">{reaction.emoji}</span>
                    <span className="share-reaction-count">{reaction.count}</span>
                </span>
            ))}
        </div>
    );
};
