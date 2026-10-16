/**
 * What the model reads back from send_sms_to_owner. A failure says whether the
 * text may still have gone out, so the model can judge sending it again.
 */
import { match } from 'ts-pattern';
import type { ToolResult } from '../../ai/tools/tool-types.js';
import type { OwnerSmsOutcome } from './owner-sms-sender.js';

/** Server answers and error reasons are cut to this many characters */
const DETAIL_LIMIT = 300;

/** Cut by code points, so an emoji is never split in half */
const clip = (text: string): string => {
    const characters = Array.from(text.trim());
    return characters.length > DETAIL_LIMIT
        ? `${characters.slice(0, DETAIL_LIMIT).join('')}…`
        : characters.join('');
};

const toolResult = (content: string, isError: boolean): ToolResult => ({
    content,
    isError,
    images: [],
    // The usage tally already shows the call
    record: null,
});

/** The server's answer after `withAnswer`, or `withoutAnswer` when it said nothing */
const serverAnswer = (serverText: string, withAnswer: string, withoutAnswer: string): string =>
    serverText.trim() === '' ? withoutAnswer : `${withAnswer}${clip(serverText)}`;

export const ownerSmsToolResult = (outcome: OwnerSmsOutcome): ToolResult =>
    match(outcome)
        .with({ kind: 'sent' }, ({ serverText }) =>
            toolResult(serverAnswer(serverText, '短信已发送。短信服务返回：', '短信已发送。'), false)
        )
        .with({ kind: 'rejected' }, ({ serverText }) =>
            toolResult(serverAnswer(serverText, '短信发送失败：', '短信发送失败，短信服务没有说明原因。'), true)
        )
        .with({ kind: 'connect-failed' }, ({ reason }) =>
            toolResult(`连接短信服务失败，短信没有发出：${clip(reason)}`, true)
        )
        .with({ kind: 'http-refused' }, ({ reason }) => toolResult(`短信发送失败：${clip(reason)}`, true))
        .with({ kind: 'failed' }, ({ reason }) =>
            toolResult(`短信服务出错，不确定短信是否已发出：${clip(reason)}`, true)
        )
        .with({ kind: 'timeout', sendStarted: true }, () =>
            toolResult('短信服务没有及时响应，不确定短信是否已发出。', true)
        )
        .with({ kind: 'timeout', sendStarted: false }, () => toolResult('连接短信服务超时，短信没有发出。', true))
        .with({ kind: 'stopped', sendStarted: true }, () =>
            toolResult('回复已停止，不确定短信是否已发出。', true)
        )
        .with({ kind: 'stopped', sendStarted: false }, () => toolResult('回复已停止，短信没有发出。', true))
        .exhaustive();
