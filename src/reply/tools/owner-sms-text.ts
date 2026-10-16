/**
 * The text send_sms_to_owner puts on the owner's phone: a prefix naming the
 * chat and the requester, then what the model wrote.
 */
import type { ReplyToolContext } from './reply-tool-context.js';

/** Stands in for the chat title in private chats */
const PRIVATE_CHAT_LABEL = '私聊';

/** `【K-ON｜<group title or 私聊>】<requester>：<content>` */
export const buildOwnerSmsText = (
    context: Pick<ReplyToolContext, 'chatTitle' | 'requester'>,
    content: string
): string => `【K-ON｜${context.chatTitle ?? PRIVATE_CHAT_LABEL}】${context.requester.name}：${content}`;
