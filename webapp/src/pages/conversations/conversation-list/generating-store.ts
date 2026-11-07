/**
 * Which chats have a reply generating, as far as an open conversation list
 * knows. The chat tab's dot reads it, so the tab bar never polls on its own:
 * only the conversation list page asks /api/status (design §5).
 */
let generatingChatIds: ReadonlySet<number> = new Set();
const listeners = new Set<() => void>();

const sameSet = (left: ReadonlySet<number>, right: ReadonlySet<number>): boolean =>
    left.size === right.size && [...left].every((id) => right.has(id));

const notify = (): void => {
    for (const listener of listeners) listener();
};

export const readGeneratingChatIds = (): ReadonlySet<number> => generatingChatIds;

export const setGeneratingChatIds = (chatIds: ReadonlySet<number>): void => {
    if (sameSet(generatingChatIds, chatIds)) return;
    generatingChatIds = chatIds;
    notify();
};

/** The page that reported this chat is gone: drop its dot */
export const clearGeneratingChat = (chatId: number): void => {
    if (!generatingChatIds.has(chatId)) return;
    const next = new Set(generatingChatIds);
    next.delete(chatId);
    generatingChatIds = next;
    notify();
};

export const subscribeGeneratingChatIds = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};
