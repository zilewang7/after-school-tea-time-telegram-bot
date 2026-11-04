/**
 * Bot API supergroup/channel ids look like -100<channel_id>; luoxu (MTProto)
 * uses the bare channel_id. Pure and dependency-free so the tools and their
 * offline cases can share it without pulling the preview stack in.
 */
export const toLuoxuChannelId = (chatId: number): number | null => {
    if (chatId >= -1_000_000_000_000) return null;
    return -chatId - 1_000_000_000_000;
};
