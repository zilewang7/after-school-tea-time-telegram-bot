import { useMemo } from 'react';
import type { PublicShareBubble, PublicShareConversation } from '../../api';
import { ShareBubble } from './share-bubble';

/** The widget index of each bubble, numbered the way the SSR page numbers them */
const widgetIndexesOf = (bubbles: readonly PublicShareBubble[]): readonly (number | null)[] => {
    let nextIndex = 0;
    return bubbles.map((bubble) => {
        if (bubble.kind !== 'bot' || bubble.widget === null) return null;
        const index = nextIndex;
        nextIndex += 1;
        return index;
    });
};

interface ShareConversationContentProps {
    token: string;
    conversation: PublicShareConversation;
}

/** A conversation share: the reply tree as read-only chat bubbles, oldest first */
export const ShareConversationContent = ({ token, conversation }: ShareConversationContentProps) => {
    const widgetIndexes = useMemo(() => widgetIndexesOf(conversation.bubbles), [conversation.bubbles]);
    return (
        <section className="section share-conversation">
            {conversation.bubbles.map((bubble, position) => (
                <ShareBubble
                    key={bubble.messageId}
                    token={token}
                    bubble={bubble}
                    widgetIndex={widgetIndexes[position] ?? null}
                    autoFocusWidget={widgetIndexes[position] === 0}
                />
            ))}
        </section>
    );
};
