/**
 * E2E cases for the test bot. Prerequisites:
 *   - luoxu-api running (test-driver endpoints on 127.0.0.1:9008)
 *   - test container up: docker compose --profile test up -d k-on-bot-test
 *     (and ~/dockers/watch-first-bot NOT running — same token)
 *
 * Run: pnpm test:e2e:bot
 */
import {
    BOT_USER_ID,
    BOT_USERNAME,
    editAsUser,
    expect,
    readGroupMessages,
    sendAsUser,
    sleep,
    waitForBotResponse,
    waitForButtonState,
    waitForStoredMessage,
} from './harness.mts';

interface CaseResult {
    name: string;
    ok: boolean;
    error?: string;
    ms: number;
}

const CASE_GAP_MS = 4000; // pace userbot sends, keep the account flood-safe

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

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: 'plain chat reply',
        body: async () => {
            const trigger = await sendAsUser(
                `@${BOT_USERNAME} 请只回复两个字:收到`
            );
            const response = await waitForBotResponse(trigger);
            expect(response.text.length > 0, 'bot produced non-empty text');
            expect(!response.errorMessage, 'no errorMessage recorded');
            const visible = await readGroupMessages(trigger);
            const botMsg = visible.find(
                (m) => m.sender_id === BOT_USER_ID && m.id === response.firstMessageId
            );
            expect(Boolean(botMsg), 'reply visible in group via MTProto read-back');
            expect(
                Boolean(botMsg && botMsg.text.includes('收到')),
                'visible text contains the requested content'
            );
        },
    },
    {
        name: 'markdown renders as entities (no raw markers visible)',
        body: async () => {
            const trigger = await sendAsUser(
                `@${BOT_USERNAME} 请原样输出下面这段 markdown(不要加代码块包裹):\n**加粗** 和 \`行内代码\` 和一个列表:\n- 第一项\n- 第二项`
            );
            const response = await waitForBotResponse(trigger);
            const visible = await readGroupMessages(trigger);
            const botMsg = visible.find(
                (m) => m.sender_id === BOT_USER_ID && m.id === response.firstMessageId
            );
            expect(Boolean(botMsg), 'reply visible in group');
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
    const results: CaseResult[] = [];
    for (const testCase of cases) {
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
