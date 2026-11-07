import { useEffect, useState } from 'react';
import type { ActiveReply } from '../../../api';
import { useApi } from '../../../context/panel-context';
import { STATUS_POLL_MS } from '../../../hooks/use-polling';
import { clearGeneratingChat, setGeneratingChatIds } from './generating-store';

export interface ActiveReplies {
    /** The replies of this chat being generated right now */
    active: readonly ActiveReply[];
    /** A poll has run and nothing of this chat is generating any more */
    finished: boolean;
}

/**
 * Polls /api/status while the list says something is generating, and stops
 * when it does not (design §5: no polling on a quiet conversation page).
 * `finished` tells the list to reload once the last reply landed.
 */
export const useActiveReplies = (chatId: number, enabled: boolean): ActiveReplies => {
    const api = useApi();
    const [active, setActive] = useState<readonly ActiveReply[]>([]);
    const [finished, setFinished] = useState(false);

    useEffect(() => {
        if (!enabled) {
            setActive([]);
            setFinished(false);
            return;
        }
        const controller = new AbortController();
        let timer: number | undefined;
        let polled = false;
        const poll = async (): Promise<void> => {
            const result = await api.getStatus(controller.signal);
            if (controller.signal.aborted) return;
            if (result.ok) {
                polled = true;
                setGeneratingChatIds(new Set(result.data.active.map((reply) => reply.chat.chatId)));
                const forChat = result.data.active.filter((reply) => reply.chat.chatId === chatId);
                setActive(forChat);
                setFinished(forChat.length === 0);
            }
            timer = window.setTimeout(() => {
                void poll();
            }, STATUS_POLL_MS);
        };
        void poll();
        return () => {
            controller.abort();
            window.clearTimeout(timer);
            clearGeneratingChat(chatId);
            // A poll that never answered leaves no dot behind either
            if (!polled) setActive([]);
        };
    }, [api, chatId, enabled]);

    return { active, finished };
};
