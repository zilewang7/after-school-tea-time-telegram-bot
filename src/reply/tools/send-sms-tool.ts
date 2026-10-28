/**
 * send_sms_to_owner: text the bot owner's phone.
 *
 * The text names the chat and the requester, so the owner knows where it came
 * from. No rate limit, intent check or dedup on purpose: the model decides.
 */
import { match } from 'ts-pattern';
import type { ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import { formatOwnerLabel, getToolConfig } from '../../config/tool-config.js';
import { ownerSmsToolResult } from './owner-sms-result.js';
import { getOwnerSmsSender, type OwnerSmsOutcome } from './owner-sms-sender.js';
import { buildOwnerSmsText } from './owner-sms-text.js';
import type { ReplyToolContext } from './reply-tool-context.js';
import { SEND_SMS_TOOL_NAME } from './tool-names.js';

const EMPTY_CONTENT: ToolResult = {
    content: 'content 必须是非空的短信正文，这次没有发送。',
    isError: true,
    images: [],
    record: null,
};

/** The trimmed `content` argument; empty when missing, not a string or blank */
const readContent = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const describeOutcome = (outcome: OwnerSmsOutcome): string =>
    match(outcome)
        .with({ kind: 'sent' }, ({ verified }) => (verified === true ? 'ok (confirmed)' : 'ok'))
        .with({ kind: 'failed' }, { sendStarted: true }, ({ kind }) => `error (${kind}, may have gone out)`)
        .otherwise(({ kind }) => `error (${kind})`);

/** One line per call; never the content or the token */
const logSend = (context: ReplyToolContext, contentLength: number, status: string): void => {
    console.log(
        `[sms] chat ${context.chatId}, requester ${context.requester.userId ?? 'unknown'}, ` +
            `content ${contentLength} chars: ${status}`
    );
};

export const createSendSmsTool = (context: ReplyToolContext): ToolHandler => ({
    definition: {
        name: SEND_SMS_TOOL_NAME,
        // e.g. 给阿主（阿主 某某，Telegram id 1234567）的手机发送一条短信
        description: `给${formatOwnerLabel(getToolConfig().owner, { idLabel: 'Telegram id', withShortName: true })}的手机发送一条短信`,
        inputSchema: {
            type: 'object',
            properties: {
                content: { type: 'string', description: '短信正文' },
            },
            required: ['content'],
        },
    },
    statusText: '📨 正在发短信…',
    execute: async (args, signal) => {
        const content = readContent(args.content);
        if (content === '') {
            logSend(context, 0, 'error (empty content)');
            return EMPTY_CONTENT;
        }

        const outcome = await getOwnerSmsSender().send(buildOwnerSmsText(context, content), signal);
        logSend(context, content.length, describeOutcome(outcome));
        return ownerSmsToolResult(outcome);
    },
});
