/**
 * Error messages of the conversation endpoints, shown to the user as is
 * (Chinese, never echoing request data).
 */
export const CONVERSATION_MESSAGES = {
    membersOnly: '该操作仅限本聊天成员',
    conversationNotFound: '会话不存在',
    messageNotFound: '消息不存在',
    replyNotFound: '回复不存在',
    notInConversation: '该消息不在本会话中',
} as const;
