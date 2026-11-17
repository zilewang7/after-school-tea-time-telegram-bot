/**
 * Bot API supergroup/channel ids look like -100<channel_id>; luoxu (MTProto)
 * uses the bare channel_id. Pure and dependency-free so the tools and their
 * offline cases can share it without pulling the preview stack in.
 */
export const toLuoxuChannelId = (chatId: number): number | null => {
    if (chatId >= -1_000_000_000_000) return null;
    return -chatId - 1_000_000_000_000;
};

/**
 * The inverse: the bot chat id for a luoxu channel id (used by the deletion
 * watcher, whose rows name channels). Private chats and basic groups have no
 * luoxu channel, so callers only ever use it for channel ids luoxu reported.
 */
export const fromLuoxuChannelId = (channelId: number): number =>
    -1_000_000_000_000 - channelId;
