/**
 * Title of the chat a reply happens in.
 *
 * Private chats and users carry no title; everything else (group, supergroup,
 * channel) does. The context builder renders this into the runtime block.
 */
export const chatTitleOf = (chat: { title?: string } | undefined): string | null =>
    typeof chat?.title === 'string' ? chat.title : null;
