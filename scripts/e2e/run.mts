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
    clickButton,
    deleteStoredMessage,
    editAsUser,
    expect,
    readLinkedMessageIds,
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

/**
 * The status line StreamingEditor rotates through while a reply is still being
 * written (src/telegram/streaming-editor.ts). A reasoning model streams its
 * thinking first, which makes catching this state easy.
 */
const STREAMING_STATUS_MARKERS = ['✽', '◐', '◑', '◒', '◓', '●', '◯', '◈', '◇', '◆', '▲', '▼'];

const hasFinishedStreaming = (message: DriverMessage): boolean =>
    !STREAMING_STATUS_MARKERS.some((marker) => message.text.includes(marker));

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

/**
 * The model every case runs against. Text-only on purpose: it is fast and cheap,
 * and it forces the picture cases through the OCR fallback rather than letting a
 * vision model read the image directly.
 */
const SUITE_MODEL = 'deepseek-v4-flash';

/** Callback data the model menu uses (see src/cmd/menu.ts) */
const MODEL_CALLBACK_PREFIX = 'mdl:';

/**
 * Drive the model switcher the way a user does: `/model`, expand the keyboard,
 * press the model. Returns the menu message id.
 */
const switchModelWithKeyboard = async (): Promise<number> => {
    const before = await readGroupMessages(0, 1);
    const lastId = before[before.length - 1]?.id ?? 0;
    await sendAsUser(`/model@${BOT_USERNAME}`);

    const findBotMessage = async (contains: string): Promise<DriverMessage | undefined> => {
        for (let attempt = 0; attempt < 20; attempt++) {
            await sleep(1500);
            const visible = await readGroupMessages(lastId);
            const found = visible.find(
                (m) => m.sender_id === BOT_USER_ID && m.text.includes(contains)
            );
            if (found) return found;
        }
        return undefined;
    };

    const menu = await findBotMessage('当前模型');
    if (!menu) throw new Error('the model menu never arrived');
    expect(menu.has_buttons, 'the model menu carries its keyboard');

    // Collapsed by default: expand, then press the model itself
    await clickButton(menu.id, `${MODEL_CALLBACK_PREFIX}expand`);
    await sleep(1500);
    await clickButton(menu.id, `${MODEL_CALLBACK_PREFIX}${SUITE_MODEL}`);

    const switched = await findBotMessage(`切换为`);
    if (!switched) throw new Error('the bot never confirmed the switch');
    expect(
        switched.text.includes(SUITE_MODEL),
        `the confirmation names ${SUITE_MODEL} (got: ${switched.text.replace(/\n/g, ' ').slice(0, 80)})`
    );
    return menu.id;
};

const cases: Array<{ name: string; full?: boolean; body: () => Promise<void> }> = [
    {
        // Runs first (see SUITE_MODEL): every later case then talks to a fast,
        // text-only model, which also means the picture cases can only pass via
        // the OCR fallback.
        name: `/model switches to ${SUITE_MODEL} through its keyboard`,
        body: async () => {
            const menuMessageId = await switchModelWithKeyboard();
            expect(menuMessageId > 0, `the model menu answered and switched to ${SUITE_MODEL}`);
        },
    },
    {
        // One LLM call covers both the basic reply pipeline and the
        // markdown → entities rendering (previously two separate cases)
        name: 'chat reply renders markdown as entities',
        body: async () => {
            // Deliberately tiny: the point is our markdown → entities
            // rendering, not how well a small fast model follows a long
            // instruction (a wordier version had it answer in prose instead).
            const trigger = await sendAsUser(
                `@${BOT_USERNAME} 请只输出这一行,不要解释,不要代码块:**加粗** 和 \`行内代码\``
            );
            const response = await waitForBotResponse(trigger);
            expect(response.text.length > 0, 'bot produced non-empty text');
            expect(!response.errorMessage, 'no errorMessage recorded');
            const botMsg = await waitForVisibleMessage(
                trigger,
                response.firstMessageId,
                hasFinishedStreaming
            );
            expect(Boolean(botMsg), 'reply visible in group via MTProto read-back');
            if (!botMsg) return;
            expect(
                !botMsg.text.includes('**') && !botMsg.text.includes('`'),
                'no raw markdown markers in visible text'
            );
            const entityTypes = botMsg.entities.map((e) => String(e['_']));
            expect(
                entityTypes.some((t) => t.includes('Bold') || t.includes('Code')),
                `markdown became a formatting entity (got: ${entityTypes.join(',') || 'none'})`
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
        // /chat records the bystanders it pulled in as its own message_links.
        // Those ids used to be merged into the target's `replies` column by a
        // read-modify-write, where a picture among them could be lost outright
        // ("完全没有看到图片的影子呀").
        name: '/chat pulls a bystander picture into the context',
        full: true,
        body: async () => {
            const target = await sendAsUser('上下文测试：这条是引用起点');
            const picture = await sendPhotoAsUser(OCR_FIXTURE);
            await waitForStoredMessage(picture);

            const trigger = await sendAsUser(
                // Always addressed: the production bot sits in this group too
                `/chat@${BOT_USERNAME} a 图片里写的那串字符是什么?只回答那串字符本身`,
                target
            );
            const response = await waitForBotResponse(trigger);
            expect(!response.errorMessage, `no error (got: ${response.errorMessage ?? ''})`);
            expect(
                response.text.includes(OCR_FIXTURE_TEXT),
                `the picture reached the model (got: ${response.text.slice(0, 120)})`
            );

            const linked = await readLinkedMessageIds(trigger);
            expect(
                linked.includes(picture),
                `the picture is linked to the /chat message (got ${JSON.stringify(linked)})`
            );
        },
    },
    {
        // A message the bot failed to store used to be a permanent hole: the
        // context tree resolves ids to rows, so replying to it only ever got
        // "I can't see that message". luoxu can still read it from Telegram.
        name: 'a message missing from the database is recovered from history',
        full: true,
        body: async () => {
            const lost = await sendAsUser('上下文测试：这条消息的暗号是 KONBACKFILL42');
            await waitForStoredMessage(lost);
            // Simulate the ingest write that SQLITE_BUSY threw away
            await deleteStoredMessage(lost);

            const trigger = await sendAsUser(
                `@${BOT_USERNAME} 上面那条消息里的暗号是什么?只回答暗号本身`,
                lost
            );
            const response = await waitForBotResponse(trigger);
            expect(!response.errorMessage, `no error (got: ${response.errorMessage ?? ''})`);
            expect(
                response.text.includes('KONBACKFILL42'),
                `the recovered message reached the model (got: ${response.text.slice(0, 120)})`
            );

            const restored = await waitForStoredMessage(lost);
            expect(
                restored.includes('KONBACKFILL42'),
                `and the row is back in the database (got: ${JSON.stringify(restored.slice(0, 60))})`
            );
        },
    },
    {
        // The @BotName form Telegram inserts in groups used to miss the command
        // regex and answer with the help text instead of a reply. And a summon
        // that carries no words of its own must still produce a real answer —
        // it used to reach the model as an empty user turn.
        name: '/chat@BotName with no words of its own still answers',
        full: true,
        body: async () => {
            const target = await sendAsUser('上下文测试：召唤起点，桌上有三只猫');
            const bystander = await sendAsUser('上下文测试：其中一只是三花');
            await waitForStoredMessage(bystander);

            const trigger = await sendAsUser(
                `/chat@${BOT_USERNAME} a`,
                target
            );
            const response = await waitForBotResponse(trigger);
            expect(!response.errorMessage, `no error (got: ${response.errorMessage ?? ''})`);
            expect(response.text.length > 0, 'the bot answered instead of printing the help');
            expect(
                !response.text.includes('仅在需要添加上下文时使用'),
                'the help text was not printed'
            );

            const linked = await readLinkedMessageIds(trigger);
            expect(
                linked.includes(bystander),
                `the bystander is linked (got ${JSON.stringify(linked)})`
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
