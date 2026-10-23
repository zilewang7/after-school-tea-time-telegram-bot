/**
 * Offline cases for send_sms_to_owner (no containers, no network beyond a
 * local stub).
 *
 * Run: npx tsx scripts/offline/tools-sms.mts
 *
 * The owner SMS server is a local Streamable-HTTP MCP stub — JSON responses,
 * stateless like the real cmcc server — whose answers the cases switch. The
 * real server sends real SMS to a real phone, so it is never contacted:
 * OWNER_SMS_MCP_URL / OWNER_SMS_MCP_TOKEN point at the stub before any project
 * module is imported, and the run refuses to start otherwise.
 *
 * Nothing here imports the db layer; the harness points DB_PATH at this
 * process's scratch file anyway, so a future transitive import can never open
 * the production database.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import type { McpServerConnection } from '../../src/ai/mcp/index.js';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

/** The per-call tool-rounds line is injected by the loops; comparisons ignore it */
const withoutRoundsLeft = (text: string): string => text.replace(/\n\n\[工具轮次\][^\n]*(?:\n\[时间\][^\n]*)?/g, '');
const json = (value: unknown): string =>
    JSON.stringify(value, (_key, item: unknown) => (typeof item === 'string' ? withoutRoundsLeft(item) : item));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (condition: () => boolean, timeoutMs = 3000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (condition()) return true;
        await sleep(25);
    }
    return condition();
};

/** Run `body` with console output captured instead of printed */
const captureConsole = async <T,>(body: () => Promise<T>): Promise<{ result: T; lines: string[] }> => {
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    const record = (...args: unknown[]): void => {
        lines.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
    };
    console.log = record;
    console.warn = record;
    console.error = record;
    try {
        return { result: await body(), lines };
    } finally {
        console.log = original.log;
        console.warn = original.warn;
        console.error = original.error;
    }
};

interface Deferred<T> {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
    readonly reject: (error: unknown) => void;
}

const deferred = <T,>(): Deferred<T> => {
    let resolve: (value: T) => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
};

// ---------------------------------------------------------------------------
// Local SMS server stub
// ---------------------------------------------------------------------------

interface StubRequest {
    /** JSON-RPC method */
    readonly method: string;
    readonly authorization: string | undefined;
    readonly params: Record<string, unknown>;
}
const stubRequests: StubRequest[] = [];

type InitializeBehaviour = 'answer' | 'unauthorized' | 'hold';
type ToolsCallBehaviour =
    | 'answer'
    | 'empty-answer'
    | 'tool-error'
    | 'empty-tool-error'
    | 'rpc-error'
    | 'http-500'
    | 'http-401'
    | 'drop'
    | 'hang';
/** How the stub answers; cases switch it and put it back */
const stub: { initialize: InitializeBehaviour; toolsCall: ToolsCallBehaviour } = {
    initialize: 'answer',
    toolsCall: 'answer',
};
/** Initialize answers held back by the 'hold' behaviour, released by the case */
const heldInitializes: Array<() => void> = [];

/** send_text as the real server lists it (tmp/mcp-cmcc-probe.log) */
const SEND_TEXT_TOOL = {
    name: 'send_text',
    description: '通过中国移动「新消息」通道给机主发送一条文本消息（默认发给通道机主本人）。',
    inputSchema: {
        type: 'object',
        properties: {
            content: { type: 'string', description: '消息内容（纯文本）' },
            to: { description: '可选：指定接收方 id（默认发给自己）', type: 'string' },
        },
        required: ['content'],
        $schema: 'http://json-schema.org/draft-07/schema#',
    },
};

const readBody = (request: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
    if (response.destroyed) return;
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(typeof body === 'string' ? body : json(body));
};

const answer = (response: ServerResponse, id: unknown, result: unknown): void =>
    sendJson(response, 200, { jsonrpc: '2.0', id, result });

const answerInitialize = (response: ServerResponse, id: unknown, params: Record<string, unknown>): void =>
    answer(response, id, {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'cmcc-newmsg-stub', version: '0.0.0' },
    });

const handleInitialize = (response: ServerResponse, id: unknown, params: Record<string, unknown>): void => {
    switch (stub.initialize) {
        case 'answer':
            answerInitialize(response, id, params);
            return;
        case 'unauthorized':
            sendJson(response, 401, '{"ok":false,"error":"unauthorized"}');
            return;
        case 'hold':
            heldInitializes.push(() => answerInitialize(response, id, params));
            return;
    }
};

const handleToolsCall = (request: IncomingMessage, response: ServerResponse, id: unknown): void => {
    switch (stub.toolsCall) {
        case 'answer':
            answer(response, id, { content: [{ type: 'text', text: '已发送' }] });
            return;
        case 'empty-answer':
            answer(response, id, { content: [] });
            return;
        case 'tool-error':
            answer(response, id, { content: [{ type: 'text', text: '通道未连接' }], isError: true });
            return;
        case 'empty-tool-error':
            answer(response, id, { content: [], isError: true });
            return;
        case 'rpc-error':
            sendJson(response, 200, { jsonrpc: '2.0', id, error: { code: -32603, message: '内部错误' } });
            return;
        case 'http-500':
            sendJson(response, 500, '{"ok":false,"error":"upstream exploded"}');
            return;
        case 'http-401':
            // The token was revoked after the connection came up
            sendJson(response, 401, '{"ok":false,"error":"token revoked"}');
            return;
        case 'drop':
            request.socket.destroy();
            return;
        case 'hang':
            // Never answers: the client has to give up on its own
            return;
    }
};

/** Streamable-HTTP MCP server in JSON-response mode, stateless */
const smsStub = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    // Like the real server: no GET stream, no session to delete
    if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
    }
    const message = asRecord(JSON.parse(await readBody(request)));
    const params = asRecord(message.params);
    const method = String(message.method);
    stubRequests.push({ method, authorization: request.headers.authorization, params });

    if (message.id === undefined) {
        response.writeHead(202).end();
        return;
    }
    if (method === 'initialize') {
        handleInitialize(response, message.id, params);
        return;
    }
    if (method === 'tools/list') {
        answer(response, message.id, { tools: [SEND_TEXT_TOOL] });
        return;
    }
    if (method === 'tools/call') {
        handleToolsCall(request, response, message.id);
        return;
    }
    sendJson(response, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
});

await new Promise<void>((resolve) => smsStub.listen(0, '127.0.0.1', resolve));
const stubAddress = smsStub.address();
if (stubAddress === null || typeof stubAddress === 'string') {
    throw new Error('the SMS stub has no TCP port');
}
const SMS_URL = `http://127.0.0.1:${stubAddress.port}/mcp`;

// ---------------------------------------------------------------------------
// Env (before any project import)
// ---------------------------------------------------------------------------

const SMS_TOKEN = 'sms-stub-token-must-never-be-logged';
process.env.OWNER_SMS_MCP_URL = SMS_URL;
process.env.OWNER_SMS_MCP_TOKEN = SMS_TOKEN;
process.env.OWNER_USER_ID = '1234567';
process.env.OWNER_DISPLAY_NAME = '测试 主人';
process.env.OWNER_SHORT_NAME = '阿主';

const { getToolConfig } = await import('../../src/config/tool-config.js');
const { createTurnTools } = await import('../../src/ai/tools/turn-tools.js');
const { buildReplyToolContext } = await import('../../src/reply/tools/reply-tool-context.js');
const { createSendSmsTool } = await import('../../src/reply/tools/send-sms-tool.js');
const { buildOwnerSmsText } = await import('../../src/reply/tools/owner-sms-text.js');
const { createOwnerSmsConnections } = await import('../../src/reply/tools/owner-sms-connection.js');
const { createOwnerSmsSender } = await import('../../src/reply/tools/owner-sms-sender.js');
const { ownerSmsToolResult } = await import('../../src/reply/tools/owner-sms-result.js');

if (getToolConfig().ownerSmsUrl !== SMS_URL) {
    throw new Error('refusing to run: OWNER_SMS_MCP_URL is not the local stub');
}

// ---------------------------------------------------------------------------
// Case helpers
// ---------------------------------------------------------------------------

const GROUP_CHAT_ID = -1004242424242;
const PRIVATE_CHAT_ID = 4242;
const REQUESTER_ID = 42;
const EMPTY_CONTENT_TEXT = 'content 必须是非空的短信正文，这次没有发送。';
/** A failure after send_text went out, without a refusal from the server */
const MAY_HAVE_GONE_OUT_PREFIX = '短信服务出错，不确定短信是否已发出：';

const smsContext = (kind: 'group' | 'private') =>
    buildReplyToolContext({
        chat:
            kind === 'group'
                ? { id: GROUP_CHAT_ID, type: 'supergroup', title: '测试群' }
                : { id: PRIVATE_CHAT_ID, type: 'private', first_name: '张三' },
        triggerMessage: { messageId: 1, userId: REQUESTER_ID, userName: '张三' },
        contextIndex: new Map(),
        signal: new AbortController().signal,
    });

const liveSignal = (): AbortSignal => new AbortController().signal;

const requestsSince = (start: number): StubRequest[] => stubRequests.slice(start);
const countSince = (start: number, method: string): number =>
    requestsSince(start).filter((request) => request.method === method).length;
const sentArguments = (start: number): unknown[] =>
    requestsSince(start)
        .filter((request) => request.method === 'tools/call')
        .map((request) => request.params.arguments);

const smsLogLines = (lines: readonly string[]): string[] => lines.filter((line) => line.startsWith('[sms]'));
const groupLogLine = (chars: number, status: string): string =>
    `[sms] chat ${GROUP_CHAT_ID}, requester ${REQUESTER_ID}, content ${chars} chars: ${status}`;

/** A connection that never talks to anyone; closing it is recorded */
const closedConnections: string[] = [];
const fakeConnection = (label: string): McpServerConnection => {
    const client = new Client({ name: label, version: '0.0.0' }, { capabilities: {} });
    client.close = async () => {
        closedConnections.push(label);
    };
    return { name: label, config: { serverUrl: 'http://127.0.0.1:9/unused' }, tools: [], client };
};

const rejectionOf = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
        () => 'resolved',
        (error: unknown) => error
    );

// The default sender (the tool's) keeps one connection across cases, so the
// cases run in order and each puts the stub behaviour back
const groupTool = createSendSmsTool(smsContext('group'));

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: 'the first send connects lazily and sends only the prefixed content, with the token',
        body: async () => {
            expect(stubRequests.length === 0, 'creating the tool contacts nobody');
            expect(
                groupTool.definition.description === '给阿主（测试 主人，Telegram id 1234567）的手机发送一条短信',
                `the description is unchanged (got ${json(groupTool.definition.description)})`
            );

            const { result, lines } = await captureConsole(() =>
                groupTool.execute({ content: '  叫主人上线  ' }, liveSignal())
            );
            expect(
                !result.isError && result.content === '短信已发送。短信服务返回：已发送',
                `success says so, with the server's answer (got ${json(result.content)})`
            );
            expect(
                result.images.length === 0 && result.record === null,
                'no images and no record: the usage tally shows the call'
            );
            const methods = requestsSince(0).map((request) => request.method);
            expect(
                json(methods) === json(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']),
                `the first send connects, then calls (got ${json(methods)})`
            );
            const call = requestsSince(0).find((request) => request.method === 'tools/call');
            expect(call?.params.name === 'send_text', 'the server tool is send_text');
            expect(
                json(call?.params.arguments) === json({ content: '【K-ON｜测试群】张三：叫主人上线' }),
                `only content goes out, trimmed and prefixed with group and requester (got ${json(call?.params.arguments)})`
            );
            expect(
                requestsSince(0).every((request) => request.authorization === `Bearer ${SMS_TOKEN}`),
                'every request carries the Bearer token'
            );
            expect(
                json(smsLogLines(lines)) === json([groupLogLine(5, 'ok')]),
                `one log line: chat, requester, length, ok (got ${json(smsLogLines(lines))})`
            );
            expect(
                lines.every((line) => !line.includes('叫主人上线') && !line.includes(SMS_TOKEN)),
                'no log line carries the content or the token'
            );
        },
    },
    {
        name: 'a private chat is labelled 私聊 and the model cannot pick the recipient',
        body: async () => {
            const start = stubRequests.length;
            const tools = createTurnTools([createSendSmsTool(smsContext('private'))]);
            const result = await tools.execute(
                { id: 'call-1', name: 'send_sms_to_owner', argumentsJson: json({ content: '在吗', to: '10086' }) },
                liveSignal()
            );
            expect(!result.isError, `the send goes through (got ${json(result.content)})`);
            expect(
                json(sentArguments(start)) === json([{ content: '【K-ON｜私聊】张三：在吗' }]),
                `a \`to\` from the model never reaches the server (got ${json(sentArguments(start))})`
            );
            expect(countSince(start, 'initialize') === 0, 'the cached connection is reused');
        },
    },
    {
        name: 'a send the server answers without any text says just that it was sent',
        body: async () => {
            stub.toolsCall = 'empty-answer';
            const { result: sent, lines } = await captureConsole(() =>
                groupTool.execute({ content: '你好' }, liveSignal())
            );
            stub.toolsCall = 'empty-tool-error';
            const refused = await groupTool.execute({ content: '你好' }, liveSignal());
            stub.toolsCall = 'answer';
            expect(
                !sent.isError && sent.content === '短信已发送。',
                `no placeholder for the missing answer (got ${json(sent.content)})`
            );
            expect(json(smsLogLines(lines)) === json([groupLogLine(2, 'ok')]), 'logged as sent');
            expect(
                refused.isError && refused.content === '短信发送失败，短信服务没有说明原因。',
                `a refusal without text says no reason was given (got ${json(refused.content)})`
            );
        },
    },
    {
        name: 'blank content is refused without reaching the server',
        body: async () => {
            const start = stubRequests.length;
            for (const args of [{}, { content: '' }, { content: ' \n\t ' }, { content: 42 }]) {
                const { result, lines } = await captureConsole(() => groupTool.execute(args, liveSignal()));
                expect(
                    result.isError && result.content === EMPTY_CONTENT_TEXT,
                    `${json(args)} is an error result (got ${json(result.content)})`
                );
                expect(
                    json(smsLogLines(lines)) === json([groupLogLine(0, 'error (empty content)')]),
                    `and logged as such (got ${json(smsLogLines(lines))})`
                );
            }
            expect(stubRequests.length === start, 'the server never hears of them');
        },
    },
    {
        name: 'a tool error from the server is an error result and keeps the connection',
        body: async () => {
            const start = stubRequests.length;
            stub.toolsCall = 'tool-error';
            const { result: refused, lines } = await captureConsole(() =>
                groupTool.execute({ content: '你好' }, liveSignal())
            );
            stub.toolsCall = 'answer';
            expect(
                refused.isError && refused.content === '短信发送失败：通道未连接',
                `the server's reason comes back (got ${json(refused.content)})`
            );
            expect(
                json(smsLogLines(lines)) === json([groupLogLine(2, 'error (rejected)')]),
                `logged as an error (got ${json(smsLogLines(lines))})`
            );

            const after = await groupTool.execute({ content: '你好' }, liveSignal());
            expect(
                !after.isError && countSince(start, 'initialize') === 0,
                'the server answered over it, so the connection stays'
            );
        },
    },
    {
        name: 'a JSON-RPC error from the server is an error result that may have gone out',
        body: async () => {
            stub.toolsCall = 'rpc-error';
            const { result, lines } = await captureConsole(() =>
                groupTool.execute({ content: '你好' }, liveSignal())
            );
            stub.toolsCall = 'answer';
            expect(
                result.isError &&
                    result.content.startsWith(MAY_HAVE_GONE_OUT_PREFIX) &&
                    result.content.includes('内部错误'),
                `the error comes back, the result unknown (got ${json(result.content)})`
            );
            expect(
                json(smsLogLines(lines)) === json([groupLogLine(2, 'error (failed, may have gone out)')]),
                `logged as such (got ${json(smsLogLines(lines))})`
            );
        },
    },
    {
        name: 'a transport failure resets the cached connection and the send is not retried',
        body: async () => {
            const failures: ToolsCallBehaviour[] = ['http-500', 'drop'];
            for (const failure of failures) {
                const start = stubRequests.length;
                stub.toolsCall = failure;
                const { result: failed, lines } = await captureConsole(() =>
                    groupTool.execute({ content: '你好' }, liveSignal())
                );
                stub.toolsCall = 'answer';
                expect(
                    failed.isError && failed.content.startsWith(MAY_HAVE_GONE_OUT_PREFIX),
                    `${failure}: an error result that may have gone out (got ${json(failed.content)})`
                );
                expect(
                    json(smsLogLines(lines)) === json([groupLogLine(2, 'error (failed, may have gone out)')]),
                    `${failure}: logged as such (got ${json(smsLogLines(lines))})`
                );
                expect(countSince(start, 'tools/call') === 1, `${failure}: send_text went out once, no retry`);

                // A token changed after the first send must not be picked up
                process.env.OWNER_SMS_MCP_TOKEN = 'a-token-set-after-the-first-send';
                const next = stubRequests.length;
                const recovered = await groupTool.execute({ content: '你好' }, liveSignal());
                process.env.OWNER_SMS_MCP_TOKEN = SMS_TOKEN;
                expect(
                    !recovered.isError && countSince(next, 'initialize') === 1,
                    `${failure}: the next send reconnects and goes through`
                );
                expect(
                    requestsSince(next).every((request) => request.authorization === `Bearer ${SMS_TOKEN}`),
                    `${failure}: with the token read once, at the first send`
                );
            }
        },
    },
    {
        name: 'an HTTP 4xx refusal says nothing was sent and resets the connection',
        body: async () => {
            const start = stubRequests.length;
            stub.toolsCall = 'http-401';
            const { result, lines } = await captureConsole(() =>
                groupTool.execute({ content: '你好' }, liveSignal())
            );
            stub.toolsCall = 'answer';
            expect(
                result.isError && result.content.startsWith('短信发送失败：') && result.content.includes('token revoked'),
                `a plain failure with the server's reason (got ${json(result.content)})`
            );
            expect(
                json(smsLogLines(lines)) === json([groupLogLine(2, 'error (http-refused)')]),
                `logged as refused (got ${json(smsLogLines(lines))})`
            );
            expect(countSince(start, 'tools/call') === 1, 'send_text went out once, no retry');

            const next = stubRequests.length;
            const recovered = await groupTool.execute({ content: '你好' }, liveSignal());
            expect(
                !recovered.isError && countSince(next, 'initialize') === 1,
                'the next send reconnects and goes through'
            );
        },
    },
    {
        name: 'stopping the reply ends a send at once and says the result is unknown',
        body: async () => {
            stub.toolsCall = 'hang';
            const stop = new AbortController();
            setTimeout(() => stop.abort(), 150);
            const startedAt = Date.now();
            const { result, lines } = await captureConsole(() =>
                groupTool.execute({ content: '你好' }, stop.signal)
            );
            const elapsed = Date.now() - startedAt;
            stub.toolsCall = 'answer';
            expect(elapsed < 2000, `the send gives up right away (took ${elapsed}ms)`);
            expect(
                result.isError && result.content === '回复已停止，不确定短信是否已发出。',
                `the model hears it may have gone out (got ${json(result.content)})`
            );
            expect(
                json(smsLogLines(lines)) === json([groupLogLine(2, 'error (stopped, may have gone out)')]),
                `logged as stopped (got ${json(smsLogLines(lines))})`
            );

            const next = stubRequests.length;
            const recovered = await groupTool.execute({ content: '你好' }, liveSignal());
            expect(
                !recovered.isError && countSince(next, 'initialize') === 1,
                'the interrupted connection is dropped: the next send reconnects'
            );
        },
    },
    {
        name: 'a send past its deadline is a timeout with an unknown result',
        body: async () => {
            stub.toolsCall = 'hang';
            const sender = createOwnerSmsSender({ url: SMS_URL, token: SMS_TOKEN }, 300);
            const startedAt = Date.now();
            const outcome = await sender.send('x', liveSignal());
            const elapsed = Date.now() - startedAt;
            stub.toolsCall = 'answer';
            expect(
                json(outcome) === json({ kind: 'timeout', sendStarted: true }),
                `a timeout after send_text went out (got ${json(outcome)})`
            );
            expect(elapsed >= 250 && elapsed < 2000, `the deadline applies (took ${elapsed}ms)`);
            expect(
                json(ownerSmsToolResult(outcome)) ===
                    json({ content: '短信服务没有及时响应，不确定短信是否已发出。', isError: true, images: [], record: null }),
                'the model hears the result is unknown'
            );
        },
    },
    {
        name: 'a finished send is never cancelled afterwards, by its deadline or a later stop',
        body: async () => {
            const start = stubRequests.length;
            const sender = createOwnerSmsSender({ url: SMS_URL, token: SMS_TOKEN }, 200);
            const stop = new AbortController();
            const sent = await sender.send('x', stop.signal);
            // A tool error keeps the connection too
            stub.toolsCall = 'tool-error';
            const rejected = await sender.send('x', stop.signal);
            stub.toolsCall = 'answer';
            stop.abort();
            await sleep(400);
            expect(
                sent.kind === 'sent' && rejected.kind === 'rejected',
                `both sends got an answer (got ${json([sent, rejected])})`
            );
            expect(
                countSince(start, 'tools/call') === 2 && countSince(start, 'notifications/cancelled') === 0,
                `no notifications/cancelled reaches the server after the deadline and the stop (got ${json(requestsSince(start).map((request) => request.method))})`
            );
        },
    },
    {
        name: 'nothing is sent when no connection comes up',
        body: async () => {
            const start = stubRequests.length;
            stub.initialize = 'unauthorized';
            const refused = await createOwnerSmsSender({ url: SMS_URL, token: 'revoked' }).send('x', liveSignal());
            stub.initialize = 'answer';
            expect(
                refused.kind === 'connect-failed' && /unauthorized/i.test(refused.reason),
                `a refused handshake fails the connect, with the reason (got ${json(refused)})`
            );
            expect(
                ownerSmsToolResult(refused).content.startsWith('连接短信服务失败，短信没有发出：'),
                `the model hears nothing was sent (got ${json(ownerSmsToolResult(refused).content)})`
            );
            expect(countSince(start, 'tools/call') === 0, 'no send_text was attempted');

            stub.initialize = 'hold';
            const slowSender = createOwnerSmsSender({ url: SMS_URL, token: SMS_TOKEN }, 300);
            const slow = await slowSender.send('x', liveSignal());
            stub.initialize = 'answer';
            expect(
                json(slow) === json({ kind: 'timeout', sendStarted: false }),
                `a handshake past the deadline is a timeout before sending (got ${json(slow)})`
            );
            expect(
                ownerSmsToolResult(slow).content === '连接短信服务超时，短信没有发出。',
                `the model hears nothing was sent (got ${json(ownerSmsToolResult(slow).content)})`
            );
            expect(countSince(start, 'tools/call') === 0, 'still no send_text');

            // The held handshake completes late: that connection serves the next send
            const released = stubRequests.length;
            heldInitializes.splice(0).forEach((release) => release());
            expect(
                await waitFor(() => countSince(released, 'tools/list') === 1),
                'the late handshake finishes'
            );
            await sleep(100);
            const next = stubRequests.length;
            const later = await slowSender.send('x', liveSignal());
            expect(
                later.kind === 'sent' && countSince(next, 'initialize') === 0,
                `the late connection is kept for the next send (got ${json(later)})`
            );

            const blankStart = stubRequests.length;
            await createOwnerSmsSender({ url: SMS_URL, token: '' }).send('x', liveSignal());
            expect(
                requestsSince(blankStart).length > 0 &&
                    requestsSince(blankStart).every((request) => request.authorization === undefined),
                'a blank token sends no Authorization header'
            );
        },
    },
    {
        name: 'connections are cached, never shared, and adopted when they come up late',
        body: async () => {
            let opened = 0;
            let pending = deferred<McpServerConnection>();
            const connections = createOwnerSmsConnections(() => {
                opened += 1;
                return pending.promise;
            });

            const firstTake = connections.take(liveSignal());
            pending.resolve(fakeConnection('a'));
            const a = await firstTake;
            expect(opened === 1 && a.name === 'a', 'the first take connects');
            connections.keep(a);
            expect((await connections.take(liveSignal())) === a && opened === 1, 'a kept connection is reused');

            // `a` is taken: a concurrent send opens its own
            pending = deferred();
            const concurrentTake = connections.take(liveSignal());
            pending.resolve(fakeConnection('b'));
            const b = await concurrentTake;
            expect(b.name === 'b' && opened === 2, 'a connection in use is never handed out twice');
            connections.keep(a);
            connections.keep(b);
            expect(json(closedConnections) === '["b"]', 'one connection is cached, the extra one closed');

            connections.discard(await connections.take(liveSignal()));
            expect(json(closedConnections) === '["b","a"]', 'a discarded connection is closed');

            // Nothing cached: a take that is stopped while connecting
            pending = deferred();
            const stop = new AbortController();
            const stoppedTake = rejectionOf(connections.take(stop.signal));
            stop.abort(new Error('stopped'));
            const stopReason = await stoppedTake;
            expect(
                stopReason instanceof Error && stopReason.message === 'stopped' && opened === 3,
                'a stop ends the wait for the connection'
            );
            pending.resolve(fakeConnection('late'));
            await sleep(0);
            const adopted = await connections.take(liveSignal());
            expect(adopted.name === 'late' && opened === 3, 'the late connection is cached for the next send');

            pending = deferred();
            const failedTake = rejectionOf(connections.take(liveSignal()));
            pending.reject(new Error('refused'));
            const failure = await failedTake;
            expect(failure instanceof Error && failure.message === 'refused', 'a failed connect fails the take');
            pending = deferred();
            const retriedTake = connections.take(liveSignal());
            pending.resolve(fakeConnection('c'));
            expect((await retriedTake).name === 'c' && opened === 5, 'and the next take connects again');

            const alreadyStopped = new AbortController();
            alreadyStopped.abort(new Error('already stopped'));
            const early = await rejectionOf(connections.take(alreadyStopped.signal));
            expect(
                early instanceof Error && early.message === 'already stopped' && opened === 5,
                'a stopped send does not connect at all'
            );
        },
    },
    {
        name: 'the SMS text names the chat and the requester',
        body: async () => {
            const requester = { userId: 7, name: '李四' };
            expect(
                buildOwnerSmsText({ chatTitle: '轻音部', requester }, '快上线') === '【K-ON｜轻音部】李四：快上线',
                'group: the group title'
            );
            expect(
                buildOwnerSmsText({ chatTitle: undefined, requester }, '快上线') === '【K-ON｜私聊】李四：快上线',
                'private: 私聊'
            );
        },
    },
    {
        name: 'every outcome reads clearly to the model, details cut short',
        body: async () => {
            const longReason = '长'.repeat(400);
            expect(
                ownerSmsToolResult({ kind: 'rejected', serverText: ` ${longReason} ` }).content ===
                    `短信发送失败：${'长'.repeat(300)}…`,
                'a long server answer is trimmed and cut'
            );
            expect(
                ownerSmsToolResult({ kind: 'sent', serverText: '🎸'.repeat(301) }).content ===
                    `短信已发送。短信服务返回：${'🎸'.repeat(300)}…`,
                'the cut never splits an emoji'
            );
            expect(
                ownerSmsToolResult({ kind: 'failed', reason: 'fetch failed' }).content ===
                    `${MAY_HAVE_GONE_OUT_PREFIX}fetch failed`,
                'a transport failure gives its reason and says the result is unknown'
            );
            expect(
                ownerSmsToolResult({ kind: 'http-refused', reason: 'HTTP 401' }).content === '短信发送失败：HTTP 401',
                'a refusal gives its reason as a plain failure'
            );
            expect(
                ownerSmsToolResult({ kind: 'stopped', sendStarted: false }).content === '回复已停止，短信没有发出。',
                'a stop before sending says nothing went out'
            );
            const failures = [
                ownerSmsToolResult({ kind: 'rejected', serverText: 'x' }),
                ownerSmsToolResult({ kind: 'connect-failed', reason: 'x' }),
                ownerSmsToolResult({ kind: 'http-refused', reason: 'x' }),
                ownerSmsToolResult({ kind: 'failed', reason: 'x' }),
                ownerSmsToolResult({ kind: 'timeout', sendStarted: false }),
                ownerSmsToolResult({ kind: 'timeout', sendStarted: true }),
                ownerSmsToolResult({ kind: 'stopped', sendStarted: false }),
                ownerSmsToolResult({ kind: 'stopped', sendStarted: true }),
            ];
            expect(
                failures.every((result) => result.isError && result.images.length === 0 && result.record === null),
                'every failure is an error result without images or record'
            );
            expect(!ownerSmsToolResult({ kind: 'sent', serverText: 'ok' }).isError, 'a send is not an error');
            expect(
                ownerSmsToolResult({ kind: 'sent', serverText: ' ' }).content === '短信已发送。',
                'a blank server answer adds nothing'
            );
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}

smsStub.closeAllConnections();
await new Promise<void>((resolve) => smsStub.close(() => resolve()));

reportResults(results);
