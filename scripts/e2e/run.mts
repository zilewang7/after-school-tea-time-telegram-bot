/**
 * E2E cases for the test bot. Prerequisites:
 *   - luoxu-api running (test-driver endpoints on 127.0.0.1:9008)
 *   - test container up: docker compose --profile test up -d k-on-bot-test
 *     (and ~/dockers/watch-first-bot NOT running — same token)
 *
 * Run: pnpm test:e2e:bot         — quick suite (reply/markdown/store//model)
 *      pnpm test:e2e:bot:full    — quick + slow edit-flow cases
 */
import {
    BOT_USER_ID,
    BOT_USERNAME,
    TEST_GROUP,
    editAsUser,
    expect,
    readAttachedMessageIds,
    readGroupMessages,
    sendAsUser,
    sendPhotoAsUser,
    sleep,
    waitForBotResponse,
    waitForButtonState,
    waitForStoredMessage,
    waitForStoredOcrText,
    type DriverMessage,
} from './harness.mts';

/** Fixture image whose only content is this exact string */
const OCR_FIXTURE = 'ocr-sample.png';
const OCR_FIXTURE_TEXT = 'OCR-TEST-XYZ789';

interface CaseResult {
    name: string;
    ok: boolean;
    error?: string;
    ms: number;
}

const CASE_GAP_MS = 4000; // pace userbot sends, keep the account flood-safe

/**
 * Poll a bot message until it satisfies the predicate. session.finalize marks
 * the DB final BEFORE the last edit is delivered, so a read right after
 * waitForBotResponse can still see an intermediate render.
 */
const waitForVisibleMessage = async (
    minId: number,
    messageId: number,
    predicate: (message: DriverMessage) => boolean,
    timeoutMs = 20_000
): Promise<DriverMessage | undefined> => {
    const deadline = Date.now() + timeoutMs;
    let latest: DriverMessage | undefined;
    while (Date.now() < deadline) {
        const visible = await readGroupMessages(minId);
        latest = visible.find((m) => m.sender_id === BOT_USER_ID && m.id === messageId);
        if (latest && predicate(latest)) return latest;
        await sleep(1500);
    }
    return latest;
};

/** Message links the bot rendered for its `#N` context references */
const contextLinksOf = (message: DriverMessage): string[] =>
    message.entities
        .map((entity) => entity['url'])
        .filter((url): url is string => typeof url === 'string')
        .filter((url) => url.startsWith(`https://t.me/c/${TEST_GROUP}/`));

/** Poll until the newest bot message (after minId) carries buttons */
const waitForVisibleButtons = async (minId: number, timeoutMs = 15_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const visible = await readGroupMessages(minId);
        const lastBotMsg = visible.filter((m) => m.sender_id === BOT_USER_ID).at(-1);
        if (lastBotMsg?.has_buttons) return true;
        await sleep(2000);
    }
    return false;
};

const runCase = async (
    name: string,
    body: () => Promise<void>
): Promise<CaseResult> => {
    console.log(`\n▶ ${name}`);
    const start = Date.now();
    try {
        await body();
        return { name, ok: true, ms: Date.now() - start };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`    ✗ ${message}`);
        return { name, ok: false, error: message, ms: Date.now() - start };
    }
};

const cases: Array<{ name: string; full?: boolean; body: () => Promise<void> }> = [
    {
        // One LLM call covers both the basic reply pipeline and the
        // markdown → entities rendering (previously two separate cases)
        name: 'chat reply renders markdown as entities',
        body: async () => {
            const trigger = await sendAsUser(
                `@${BOT_USERNAME} 请原样输出下面这段 markdown(不要加代码块包裹):\n**加粗** 和 \`行内代码\` 和一个列表:\n- 第一项\n- 第二项`
            );
            const response = await waitForBotResponse(trigger);
            expect(response.text.length > 0, 'bot produced non-empty text');
            expect(!response.errorMessage, 'no errorMessage recorded');
            const visible = await readGroupMessages(trigger);
            const botMsg = visible.find(
                (m) => m.sender_id === BOT_USER_ID && m.id === response.firstMessageId
            );
            expect(Boolean(botMsg), 'reply visible in group via MTProto read-back');
            if (!botMsg) return;
            expect(
                !botMsg.text.includes('**') && !botMsg.text.includes('`'),
                'no raw markdown markers in visible text'
            );
            const entityTypes = botMsg.entities.map((e) => String(e['_']));
            expect(
                entityTypes.some((t) => t.includes('Bold')),
                `bold entity present (got: ${entityTypes.join(',') || 'none'})`
            );
        },
    },
    {
        // The `#N` context numbers the model writes must become clickable
        // links in the visible message while the stored text stays plain
        name: 'context number in the reply becomes a clickable link',
        body: async () => {
            const target = await sendAsUser('编号链接测试：这一条是被引用的消息');
            const trigger = await sendAsUser(
                `@${BOT_USERNAME} 请原样输出这一行,不要加任何别的内容:参见 #1 的说明`,
                target
            );
            const response = await waitForBotResponse(trigger);
            expect(response.text.includes('#1'), `stored text keeps the plain number (got: ${response.text.slice(0, 80)})`);
            expect(
                !response.text.includes('t.me'),
                'stored text carries no link (context stays clean for the next turn)'
            );

            const expectedUrl = `https://t.me/c/${TEST_GROUP}/${target}`;
            const botMsg = await waitForVisibleMessage(
                trigger,
                response.firstMessageId,
                (message) => contextLinksOf(message).includes(expectedUrl)
            );
            expect(Boolean(botMsg), 'reply visible in group via MTProto read-back');
            if (!botMsg) return;
            expect(botMsg.text.includes('#1'), 'visible text still reads "#1"');
            const urls = contextLinksOf(botMsg);
            expect(
                urls.includes(expectedUrl),
                `"#1" links to the referenced message (want ${expectedUrl}, got: ${urls.join(',') || 'none'})`
            );
        },
    },
    {
        // Regression guard for the Gemini replay: modelParts is only the last
        // streamed chunk, so using it as the whole model turn replayed every
        // past reply as empty. The secret lives ONLY in the bot's own reply, so
        // repeating it proves the reply text really reaches the model.
        name: 'bot can read its own past reply and cite its number',
        body: async () => {
            const first = await sendAsUser(
                `@${BOT_USERNAME} 请只回复这一句,不要加别的内容:暗号是 XYZ123`
            );
            const firstResponse = await waitForBotResponse(first);
            expect(
                firstResponse.text.includes('XYZ123'),
                `bot echoed the secret (got: ${firstResponse.text.slice(0, 60)})`
            );
            expect(
                !firstResponse.text.trimStart().startsWith('[#'),
                `bot did not imitate the [#N] label (got: ${firstResponse.text.slice(0, 30)})`
            );

            const followUp = await sendAsUser(
                `@${BOT_USERNAME} 你之前说的暗号是什么?请回答暗号本身,并用 #编号 指出你是在哪条消息里说的`,
                firstResponse.firstMessageId
            );
            const second = await waitForBotResponse(followUp);
            expect(!second.errorMessage, `no error on the follow-up turn (got: ${second.errorMessage ?? ''})`);
            expect(
                second.text.includes('XYZ123'),
                `bot recalled the secret from its own reply (got: ${second.text.slice(0, 120)})`
            );
            expect(/#\d+/.test(second.text), `bot cited a context number (got: ${second.text.slice(0, 120)})`);

            const expectedUrl = `https://t.me/c/${TEST_GROUP}/${firstResponse.firstMessageId}`;
            const botMsg = await waitForVisibleMessage(
                followUp,
                second.firstMessageId,
                (message) => contextLinksOf(message).length > 0
            );
            expect(Boolean(botMsg), 'follow-up reply visible in group');
            if (!botMsg) return;
            const urls = contextLinksOf(botMsg);
            expect(
                urls.includes(expectedUrl),
                `the cited number links to the bot's own reply, i.e. its first message (want ${expectedUrl}, got: ${urls.join(',') || 'none'})`
            );
        },
    },
    {
        // /chat attaches bystander messages to the reply target. Those ids used
        // to be lost to a write race, and a picture among them simply never
        // reached the model ("完全没有看到图片的影子呀").
        name: '/chat pulls a bystander picture into the context',
        full: true,
        body: async () => {
            const target = await sendAsUser('上下文测试：这条是引用起点');
            const picture = await sendPhotoAsUser(OCR_FIXTURE);
            await waitForStoredMessage(picture);

            const trigger = await sendAsUser(
                '/chat a 图片里写的那串字符是什么?只回答那串字符本身',
                target
            );
            const response = await waitForBotResponse(trigger);
            expect(!response.errorMessage, `no error (got: ${response.errorMessage ?? ''})`);
            expect(
                response.text.includes(OCR_FIXTURE_TEXT),
                `the picture reached the model (got: ${response.text.slice(0, 120)})`
            );

            const attached = await readAttachedMessageIds(target);
            expect(
                attached.includes(picture),
                `the picture is attached to the target (got ${JSON.stringify(attached)})`
            );
        },
    },
    {
        // Text recognized in an image is stored so models that cannot see
        // pictures still get its content.
        name: 'image text is recognized and stored for text-only models',
        full: true,
        body: async () => {
            const picture = await sendPhotoAsUser(OCR_FIXTURE);
            const ocrText = await waitForStoredOcrText(picture);
            expect(
                ocrText.includes(OCR_FIXTURE_TEXT),
                `OCR stored on the message row (got: ${ocrText.slice(0, 80)})`
            );
        },
    },
    {
        name: 'formatted user message is stored as markdown',
        body: async () => {
            // telethon's default parse_mode is markdown: **…** arrives as a
            // bold entity, `…` as code — exactly what a formatted user
            // message looks like to the bot
            const messageId = await sendAsUser(
                '格式落库测试 **加粗内容** 和 `code_span` 结束'
            );
            const stored = await waitForStoredMessage(messageId);
            expect(
                stored.includes('**加粗内容**'),
                `bold entity stored as **markdown** (got: ${stored.slice(0, 80)})`
            );
            expect(
                stored.includes('`code_span`'),
                'code entity stored as `markdown`'
            );
        },
    },
    {
        name: '/model command works and is scoped to the test chat',
        body: async () => {
            const before = await readGroupMessages(0, 1);
            const lastId = before[before.length - 1]?.id ?? 0;
            await sendAsUser(`/model@${BOT_USERNAME}`);
            let found = false;
            for (let attempt = 0; attempt < 20 && !found; attempt++) {
                await sleep(2000);
                const visible = await readGroupMessages(lastId);
                found = visible.some(
                    (m) => m.sender_id === BOT_USER_ID && m.text.includes('当前模型')
                );
            }
            expect(found, 'bot answered /model with current-model info');
        },
    },
    {
        name: 'edit after completion adds retry button',
        full: true,
        body: async () => {
            const trigger = await sendAsUser(
                `@${BOT_USERNAME} 请只回复两个字:好的`
            );
            const response = await waitForBotResponse(trigger);
            expect(response.buttonState === 'none', 'response finished without buttons');
            await editAsUser(trigger, `@${BOT_USERNAME} 请只回复两个字:改了`);
            await waitForButtonState(trigger, 'edit_detected');
            console.log('    ✓ buttonState reached edit_detected');
            expect(
                await waitForVisibleButtons(trigger),
                'retry button visible on the bot message'
            );
            // Editing again while already EDIT_DETECTED re-applies (self-heal)
            await editAsUser(trigger, `@${BOT_USERNAME} 请只回复两个字:又改`);
            await sleep(4000);
            expect(
                await waitForVisibleButtons(trigger),
                'retry button still present after a second edit'
            );
        },
    },
    {
        name: 'edit during generation adds retry button on the final edit',
        full: true,
        body: async () => {
            const trigger = await sendAsUser(
                `@${BOT_USERNAME} 请写一段 200 字左右的轻音部日常小故事`
            );
            // Edit while the bot is still streaming
            await sleep(3000);
            await editAsUser(
                trigger,
                `@${BOT_USERNAME} 请写一段 200 字左右的轻音部日常小故事(要有梓喵)`
            );
            const response = await waitForBotResponse(trigger);
            expect(
                response.buttonState === 'edit_detected',
                `final buttonState is edit_detected (got: ${response.buttonState})`
            );
            expect(
                await waitForVisibleButtons(trigger),
                'retry button visible on the bot message'
            );
        },
    },
];

const main = async (): Promise<void> => {
    const runFull = process.argv.includes('--full');
    const selected = cases.filter((testCase) => runFull || !testCase.full);
    console.log(`Running ${runFull ? 'FULL' : 'QUICK'} suite: ${selected.length}/${cases.length} cases`);

    const results: CaseResult[] = [];
    for (const testCase of selected) {
        results.push(await runCase(testCase.name, testCase.body));
        await sleep(CASE_GAP_MS);
    }

    console.log('\n==== e2e summary ====');
    for (const result of results) {
        const mark = result.ok ? 'PASS' : 'FAIL';
        console.log(`${mark}  ${result.name} (${(result.ms / 1000).toFixed(1)}s)`);
    }
    if (results.some((r) => !r.ok)) process.exit(1);
};

await main();
