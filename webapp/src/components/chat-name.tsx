import { useMemo } from 'react';
import { chatNameOf, chatUsernameOf } from '../format';
import type { ChatNameSource } from '../format';

interface ChatNameProps {
    chat: ChatNameSource;
}

/** The chat's name, followed by its @username in a quieter tone when it has one */
export const ChatName = ({ chat }: ChatNameProps) => {
    const name = useMemo(() => chatNameOf(chat), [chat]);
    const username = useMemo(() => chatUsernameOf(chat), [chat]);

    return (
        <>
            {name}
            {username !== null && <span className="chat-username">{username}</span>}
        </>
    );
};
