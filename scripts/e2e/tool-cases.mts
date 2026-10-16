/**
 * Client tool cases: opt-in with `--tools` (`pnpm test:e2e:bot:tools`), never
 * part of the quick run — every case is a multi-round tool loop, and two of
 * them draw real pictures on Nano Banana 2.1, whose dynamic quota the test bot
 * shares with production. So a run draws at most IMAGE_GENERATIONS_PER_RUN
 * pictures, each request IMAGE_REQUEST_GAP_MS after the previous picture reply.
 *
 * They run on gemini-3.8-flash: argon's first-byte tail outlasts any sane wait,
 * and Gemini's tool loop is the new one. The database is the primary witness;
 * the container log covers what it does not keep (how many tools a turn was
 * offered, how many references a picture used, photo or document). When the
 * log cannot be read, those checks say so instead of guessing.
 */
import {
    BOT_USERNAME,
    expect,
    expectPresent,
    hasFinishedStreaming,
    readLinkedMessageIds,
    readMediaMessageIds,
    readStoredMessage,
    sendAsUser,
    sleep,
    waitForBotResponse,
    type DriverMessage,
    type FinalBotResponse,
    type StoredImage,
} from './harness.mts';
import { readContainerLogLines } from './container-logs.mts';
import { ensureModel, skip, waitForFinishedReply, type E2eCase } from './suite-helpers.mts';

const TOOLS_MODEL = 'gemini-3.8-flash';
/** The 180s tool loop deadline, its final round and the delivery */
const TOOL_REPLY_TIMEOUT_MS = 300_000;

/** context7's MCP tools (get-library-docs is the name before context7 v2) */
const CONTEXT7_TOOL_NAMES: readonly string[] = ['resolve-library-id', 'query-docs', 'get-library-docs'];
const GENERATE_IMAGE = 'generate_image';
const SEND_SMS = 'send_sms_to_owner';

const IMAGE_GENERATIONS_PER_RUN = 3;
const IMAGE_REQUEST_GAP_MS = 35_000;
/** A failed picture must not turn into a burst of retries on the shared quota */
const ONE_ATTEMPT = '生图工具只调用一次，失败了不要重试，直接告诉我原因。';

// ---------------------------------------------------------------------------
// Log lines the cases read, with the file that writes each
// ---------------------------------------------------------------------------

/** src/reply/tools/generate-image-tool.ts: `[generate_image] 1 reference(s), aspect=auto: image/png 734012B` */
const GENERATION_LINE = /\[generate_image\] (\d+) reference\(s\), aspect=\S+: (.+)$/;
/** src/ai/platforms/gemini-platform.ts: `[gemini] gemini-3.8-flash offers 3 client tool(s)` */
const GEMINI_OFFER_LINE = /\[gemini\] \S+ offers (\d+) client tool/;
/** src/ai/mcp/client.ts: `[mcp] Server "context7-mcp" connected: 2 tool(s) [...]` */
const MCP_CONNECTED_LINE = /\[mcp\] Server "([^"]+)" connected: (\d+) tool\(s\)/;
/** src/reply/response-handler.ts */
const PHOTO_SENT_LINE = '[response-handler] Sending photo:';
const DOCUMENT_FALLBACK_LINE = 'sendPhoto failed, fallback to sendDocument';
/** src/reply/tools/send-sms-tool.ts, and the per-call line of src/ai/tools/turn-tools.ts */
const SMS_RAN_LINES = ['[sms] chat ', `[tools] ${SEND_SMS} took`];

interface GenerationLine {
    readonly references: number;
    /** `image/png 734012B` on success, else the failure: `busy`, `blocked (…)`, … */
    readonly outcome: string;
}

const generationLinesIn = (lines: readonly string[]): GenerationLine[] =>
    lines.flatMap((line) => {
        const found = GENERATION_LINE.exec(line);
        return found ? [{ references: Number(found[1]), outcome: found[2] ?? '' }] : [];
    });

const describeGenerations = (generations: readonly GenerationLine[]): string =>
    generations.map((line) => `${line.references} ref(s) → ${line.outcome}`).join('; ') || 'no generation logged';

const offeredToolCountsIn = (lines: readonly string[]): number[] =>
    lines.flatMap((line) => {
        const found = GEMINI_OFFER_LINE.exec(line);
        return found ? [Number(found[1])] : [];
    });

/** How many tools context7 listed when the bot connected; undefined when not logged */
const context7ToolCountIn = (lines: readonly string[]): number | undefined =>
    lines
        .flatMap((line) => {
            const found = MCP_CONNECTED_LINE.exec(line);
            return found && found[1]?.includes('context7') ? [Number(found[2])] : [];
        })
        .at(-1);

// ---------------------------------------------------------------------------
// Run state and helpers
// ---------------------------------------------------------------------------

interface DrawnPicture {
    /** The bot's reply row, which carries the picture into later contexts */
    readonly botMessageId: number;
    readonly sha256: string;
}

/** What the earlier tool cases of this run leave for the later ones */
interface ToolRunState {
    /** When the first tool case started: this run's log window */
    startedAt: number | undefined;
    usedToolNames: Set<string>;
    imageGenerations: number;
    lastImageReplyAt: number | undefined;
    drawnPicture: DrawnPicture | undefined;
}

const toolRun: ToolRunState = {
    startedAt: undefined,
    usedToolNames: new Set(),
    imageGenerations: 0,
    lastImageReplyAt: undefined,
    drawnPicture: undefined,
};

/** Every tool case starts here: its model, and the start of the run's log window */
const beginToolCase = async (): Promise<number> => {
    await ensureModel(TOOLS_MODEL);
    const startedAt = Date.now();
    toolRun.startedAt ??= startedAt;
    return startedAt;
};

const waitForToolReply = async (trigger: number): Promise<FinalBotResponse> => {
    const response = await waitForBotResponse(trigger, TOOL_REPLY_TIMEOUT_MS);
    for (const entry of response.toolUsage) toolRun.usedToolNames.add(entry.name);
    return response;
};

const describeToolUsage = (response: FinalBotResponse): string =>
    response.toolUsage.map((entry) => `${entry.name} x${entry.count}`).join(', ') || 'none';

/** Before a picture request: the run's budget, then the gap since the last picture reply */
const awaitImageSlot = async (): Promise<void> => {
    if (toolRun.imageGenerations >= IMAGE_GENERATIONS_PER_RUN) {
        skip(`本次已生成 ${toolRun.imageGenerations} 张图（每次运行上限 ${IMAGE_GENERATIONS_PER_RUN}），本条跳过`);
    }
    const waitMs = (toolRun.lastImageReplyAt ?? 0) + IMAGE_REQUEST_GAP_MS - Date.now();
    if (waitMs > 0) {
        console.log(`    … ${Math.ceil(waitMs / 1000)}s pause: picture requests stay ${IMAGE_REQUEST_GAP_MS / 1000}s apart`);
        await sleep(waitMs);
    }
};

interface PictureReply {
    readonly response: FinalBotResponse;
    /** This case's container log; null when it cannot be read */
    readonly logLines: string[] | null;
    readonly generations: readonly GenerationLine[];
}

/**
 * A reply that was asked for a picture. Its end starts the next gap, and the
 * generations it made (from the log; one when that is unreadable) count
 * against the run's budget.
 */
const waitForPictureReply = async (trigger: number, startedAt: number): Promise<PictureReply> => {
    let generationsMade = 1;
    try {
        const response = await waitForToolReply(trigger);
        const logLines = await readContainerLogLines(startedAt);
        const generations = generationLinesIn(logLines ?? []);
        if (logLines !== null) generationsMade = generations.length;
        return { response, logLines, generations };
    } finally {
        toolRun.imageGenerations += generationsMade;
        toolRun.lastImageReplyAt = Date.now();
    }
};

/** 2.1's quota is dynamic and shared with production: a 429 says nothing about this code */
const skipWhenBusy = (reply: PictureReply): void => {
    if (reply.response.image === undefined && reply.generations.some((line) => line.outcome === 'busy')) {
        skip('Nano Banana 2.1 繁忙（429，配额与生产共享），本条跳过');
    }
};

/**
 * The DB says final before the last edit is delivered, and a tool's status line
 * ("🎨 正在画图…") must not pass for a finished reply: every message of the
 * version is visible and none shows a status line any more.
 */
const expectReplyFinished = (visible: readonly DriverMessage[], response: FinalBotResponse): void => {
    const stillRunning = visible
        .filter((message) => !hasFinishedStreaming(message))
        .map((message) => `${message.id}: ${JSON.stringify(message.text.split('\n').at(-1))}`);
    expect(
        visible.length === response.messageIds.length && stillRunning.length === 0,
        `every message of the reply is visible and final (${visible.length}/${response.messageIds.length} visible` +
            `${stillRunning.length > 0 ? `; still showing a status line: ${stillRunning.join(', ')}` : ''})`
    );
};

/** The stored caption is markdown, Telegram shows it rendered (cut at 1024 characters) */
const plainLetters = (text: string): string => text.replace(/[\s*_`~|>#[\]()]/g, '');

const showsCaption = (message: DriverMessage | undefined, caption: string): boolean => {
    const shown = plainLetters(message?.text ?? '');
    return shown.length > 0 && plainLetters(caption).includes(shown);
};

/** Only the log tells a photo apart from the document fallback */
const expectSentAsPhoto = (logLines: readonly string[] | null): void => {
    if (logLines === null) {
        console.log('    ↷ container log not readable: photo or document not checked');
        return;
    }
    expect(
        logLines.some((line) => line.includes(PHOTO_SENT_LINE)) &&
            !logLines.some((line) => line.includes(DOCUMENT_FALLBACK_LINE)),
        'the picture went out as a photo, not as the document fallback'
    );
};

/** What both picture cases check on the final reply; returns its picture */
const expectPictureDelivered = async (trigger: number, reply: PictureReply): Promise<StoredImage> => {
    const { response } = reply;
    expect(!response.errorMessage, `no errorMessage recorded (got: ${response.errorMessage ?? ''})`);
    expect(
        response.toolUsage.some((entry) => entry.name === GENERATE_IMAGE),
        `the reply called ${GENERATE_IMAGE} (tool usage: ${describeToolUsage(response)})`
    );
    const { image } = response;
    expectPresent(
        image,
        `the final version has an image (${image ? `${image.bytes} bytes` : `generations: ${describeGenerations(reply.generations)}; reply: ${response.text.slice(0, 120)}`})`
    );
    const caption = response.imageCaption?.trim() ?? '';
    expect(caption.length > 0, `and a non-empty imageCaption (got: ${JSON.stringify(response.imageCaption)})`);

    // The row later turns read: the picture, and what the bot captioned it
    const row = await readStoredMessage(response.firstMessageId);
    expect(
        (row?.fileBytes ?? 0) > 0,
        `the bot's message row keeps the picture for later turns (${row?.fileMime ?? 'no file'})`
    );
    expect((row?.text ?? '').includes(caption), 'and its text carries the caption');

    // What the group sees: final text first, then the picture with its caption
    const visible = await waitForFinishedReply(trigger, response.messageIds);
    expectReplyFinished(visible, response);
    const pictureMessage = visible.find((message) => message.id === response.currentMessageId);
    expect(
        pictureMessage !== undefined && response.currentMessageId !== response.firstMessageId,
        `the picture is a message of its own after the text (message ${response.currentMessageId})`
    );
    expect(
        showsCaption(pictureMessage, caption),
        `it shows the caption (shown: ${JSON.stringify(pictureMessage?.text.slice(0, 80))}, stored: ${JSON.stringify(caption.slice(0, 80))})`
    );
    expectSentAsPhoto(reply.logLines);
    return image;
};

/**
 * The log only counts a generation's references, so "the earlier picture" is
 * proven when it was the only picture the context held.
 */
const expectEarlierPictureReferenced = async (
    reply: PictureReply,
    linkedMessageIds: readonly number[],
    drawn: DrawnPicture
): Promise<void> => {
    if (reply.logLines === null) {
        console.log('    ↷ container log not readable: the references used are not checked');
        return;
    }
    const references = Math.max(0, ...reply.generations.map((line) => line.references));
    expect(references > 0, `the generation used a reference picture (${describeGenerations(reply.generations)})`);

    const mediaInContext = await readMediaMessageIds(linkedMessageIds);
    if (mediaInContext.length !== 1 || mediaInContext[0] !== drawn.botMessageId) {
        console.log(
            `    ↷ the context held other media too (${mediaInContext.join(', ')}): the log cannot say which was referenced`
        );
        return;
    }
    console.log(`    ✓ the earlier picture (message ${drawn.botMessageId}) was the only one in the context, so it was the reference`);
};

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export const toolCases: E2eCase[] = [
    {
        // The Gemini tool loop end to end: function calls out, MCP results
        // back, then a final answer whose Tools block records the calls
        name: 'tools: Gemini answers through context7 (MCP) in its tool loop',
        tools: true,
        body: async () => {
            await beginToolCase();
            const trigger = await sendAsUser(
                `@${BOT_USERNAME} 请先用 context7 查一下 grammY 的文档，再用两三句话回答：sendPhoto 的 caption_entities 参数怎么传？`
            );
            const response = await waitForToolReply(trigger);
            expect(!response.errorMessage, `no errorMessage recorded (got: ${response.errorMessage ?? ''})`);
            expect(response.text.trim().length > 0, `the final version has text (got: ${response.text.slice(0, 80)})`);
            const context7Calls = response.toolUsage.filter((entry) => CONTEXT7_TOOL_NAMES.includes(entry.name));
            expect(context7Calls.length > 0, `its tool usage shows a context7 tool (got: ${describeToolUsage(response)})`);

            const visible = await waitForFinishedReply(trigger, response.messageIds);
            expectReplyFinished(visible, response);
            expect(
                visible.some((message) => context7Calls.some((entry) => message.text.includes(entry.name))),
                'the visible Tools block names the context7 call'
            );
        },
    },
    {
        name: 'tools: generate_image draws a picture that goes out with its caption',
        tools: true,
        body: async () => {
            const startedAt = await beginToolCase();
            await awaitImageSlot();
            const trigger = await sendAsUser(
                `@${BOT_USERNAME} 画一张简单的图发出来：白色背景上放着一个红苹果，配一句简短的配文。${ONE_ATTEMPT}`
            );
            const reply = await waitForPictureReply(trigger, startedAt);
            skipWhenBusy(reply);

            const image = await expectPictureDelivered(trigger, reply);
            toolRun.drawnPicture = { botMessageId: reply.response.firstMessageId, sha256: image.sha256 };
        },
    },
    {
        // Not a reply to anything: `/chat r` brings the recent conversation into
        // the context, so the picture is reachable only as one of its #N, which
        // the model has to pick by itself
        name: "tools: a later request edits the bot's own picture without replying to it",
        tools: true,
        body: async () => {
            const drawn = toolRun.drawnPicture ?? skip('需要上一条画出的图，但它没有出图，本条跳过');
            const startedAt = await beginToolCase();
            await awaitImageSlot();
            const trigger = await sendAsUser(
                `/chat@${BOT_USERNAME} r 把你刚才画的那张苹果图改一下：苹果换成绿色的，其余保持不变，改好发出来。${ONE_ATTEMPT}`
            );
            const reply = await waitForPictureReply(trigger, startedAt);
            skipWhenBusy(reply);

            const linked = await readLinkedMessageIds(trigger);
            expect(
                linked.includes(drawn.botMessageId),
                `the earlier picture was in the context (/chat r linked message ${drawn.botMessageId} among ${linked.length})`
            );
            const image = await expectPictureDelivered(trigger, reply);
            expect(image.sha256 !== drawn.sha256, 'it is a new picture, not the earlier one sent again');
            await expectEarlierPictureReferenced(reply, linked, drawn);
        },
    },
    {
        // The test instance inherits the production env, so SMS has to be off
        // by default there. Nothing stores the tool list a turn was offered, but
        // the Gemini log line counts it: context7's tools + generate_image, and
        // send_sms_to_owner would make it one more.
        name: 'tools: the test instance never offers send_sms_to_owner',
        tools: true,
        body: async () => {
            const runStartedAt = toolRun.startedAt ?? skip('没有先跑别的工具用例，没有可观察的工具回合，本条跳过');
            expect(
                !toolRun.usedToolNames.has(SEND_SMS),
                `no reply of this run used ${SEND_SMS} (tools used: ${[...toolRun.usedToolNames].join(', ') || 'none'})`
            );

            const wholeLog = (await readContainerLogLines()) ?? skip('读不到容器日志，无法观察本轮提供了哪些工具，本条跳过');
            expect(
                !wholeLog.some((line) => SMS_RAN_LINES.some((marker) => line.includes(marker))),
                `the container log shows no ${SEND_SMS} call`
            );

            const offered = offeredToolCountsIn((await readContainerLogLines(runStartedAt)) ?? []);
            if (offered.length === 0) {
                skip('日志里没有 "[gemini] … offers N client tool(s)"，数不出提供了几个工具，本条跳过');
            }
            const context7Tools =
                context7ToolCountIn(wholeLog) ?? skip('日志里没有 context7 的连接记录，算不出应有的工具数，本条跳过');
            const expected = context7Tools + 1;
            expect(
                offered.every((count) => count === expected),
                `every Gemini tool turn offered ${expected} tools: context7's ${context7Tools} + ${GENERATE_IMAGE}; ${SEND_SMS} would make one more (offered: ${offered.join(', ')})`
            );
        },
    },
];
