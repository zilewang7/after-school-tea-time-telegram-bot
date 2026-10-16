/**
 * E2E harness for driving the test bot (@WatchFirstBot) through real Telegram.
 *
 * Drive:  luoxu-api /test/send — the userbot posts a trigger message into the
 *         dedicated test group (server-side whitelisted to that group only).
 * Verify: primary — the test bot's own sqlite (bot_responses row keyed by our
 *         trigger message id; buttonState leaving 'processing' = final state);
 *         secondary — luoxu-api /test/messages MTProto read-back of what is
 *         actually visible in the group (text + entities);
 *         last — the container log (container-logs.mts) for what neither keeps.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sqlite3 from 'sqlite3';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

export const LUOXU_BASE = 'http://127.0.0.1:9008/luoxu';
/** MTProto id of the dedicated test group (Bot API: -100<id>) */
export const TEST_GROUP = 2311128579;
export const TEST_CHAT_ID = -1002311128579;
export const TEST_DB_PATH = join(repoRoot, 'database.test.sqlite');

const readEnvValue = (key: string): string => {
    const content = readFileSync(join(repoRoot, '.env.test'), 'utf8');
    const line = content
        .split('\n')
        .find((l) => l.startsWith(`${key}=`) && !l.startsWith('#'));
    if (!line) throw new Error(`${key} not found in .env.test`);
    return line.slice(key.length + 1).trim();
};

const readOptionalEnvValue = (key: string): string | undefined => {
    try {
        return readEnvValue(key);
    } catch {
        return undefined;
    }
};

export const BOT_USERNAME = readEnvValue('BOT_USER_NAME');
export const BOT_USER_ID = Number(readEnvValue('BOT_USER_ID'));
/** The /pic backend. Absent (or offline) makes the pic case skip, not fail. */
export const COMFY_FORWARD_URL = readOptionalEnvValue('COMFY_FORWARD_URL');

export interface DriverMessage {
    id: number;
    sender_id: number;
    text: string;
    entities: Array<Record<string, unknown>>;
    reply_to: number | null;
    edit_date: number | null;
    date: number | null;
    has_buttons: boolean;
}

/** Send a message into the test group as the userbot; returns its message id */
export const sendAsUser = async (text: string, replyTo?: number): Promise<number> => {
    const res = await fetch(`${LUOXU_BASE}/test/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ g: TEST_GROUP, text, reply_to: replyTo }),
    });
    if (!res.ok) throw new Error(`/test/send HTTP ${res.status}`);
    const payload = (await res.json()) as { message_id: number };
    return payload.message_id;
};

/**
 * Post a real photo into the test group as the userbot; returns its message id.
 * The bot side cannot be driven to send as a user, so this goes through the
 * MTProto test driver with a fixture from scripts/e2e/fixtures.
 */
export const sendPhotoAsUser = async (
    fixtureName: string,
    options: { caption?: string; replyTo?: number } = {}
): Promise<number> => {
    const bytes = readFileSync(join(repoRoot, 'scripts/e2e/fixtures', fixtureName));
    const res = await fetch(`${LUOXU_BASE}/test/send-media`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            g: TEST_GROUP,
            data: bytes.toString('base64'),
            name: fixtureName,
            caption: options.caption,
            reply_to: options.replyTo,
        }),
    });
    if (!res.ok) throw new Error(`/test/send-media HTTP ${res.status}`);
    const payload = (await res.json()) as { message_id: number };
    return payload.message_id;
};

/** Edit a previously sent userbot message (triggers edit-detected retry) */
export const editAsUser = async (messageId: number, text: string): Promise<void> => {
    const res = await fetch(`${LUOXU_BASE}/test/edit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ g: TEST_GROUP, message_id: messageId, text }),
    });
    if (!res.ok) throw new Error(`/test/edit HTTP ${res.status}`);
};

/** Read messages from the test group (ascending), newer than minId */
export const readGroupMessages = async (minId: number, limit = 50): Promise<DriverMessage[]> => {
    const res = await fetch(
        `${LUOXU_BASE}/test/messages?g=${TEST_GROUP}&min_id=${minId}&limit=${limit}`
    );
    if (!res.ok) throw new Error(`/test/messages HTTP ${res.status}`);
    const payload = (await res.json()) as { messages: DriverMessage[] };
    return payload.messages;
};

interface BotResponseRow {
    messageId: number;
    userMessageId: number;
    buttonState: string;
    versions: string;
}

const queryOne = <T,>(sql: string, params: unknown[]): Promise<T | undefined> =>
    new Promise((resolve, reject) => {
        const db = new sqlite3.Database(TEST_DB_PATH, sqlite3.OPEN_READONLY, (openErr) => {
            if (openErr) return reject(openErr);
            db.get(sql, params, (err, row) => {
                db.close();
                if (err) reject(err);
                else resolve(row as T | undefined);
            });
        });
    });

const queryAll = <T,>(sql: string, params: unknown[]): Promise<T[]> =>
    new Promise((resolve, reject) => {
        const db = new sqlite3.Database(TEST_DB_PATH, sqlite3.OPEN_READONLY, (openErr) => {
            if (openErr) return reject(openErr);
            db.all(sql, params, (err, rows) => {
                db.close();
                if (err) reject(err);
                else resolve(rows as T[]);
            });
        });
    });

/**
 * Press an inline-keyboard button on a bot message, by its callback data. Lets
 * the suite drive what only exists behind buttons (the model switcher).
 */
export const clickButton = async (messageId: number, data: string): Promise<void> => {
    const res = await fetch(`${LUOXU_BASE}/test/click`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ g: TEST_GROUP, message_id: messageId, data }),
    });
    if (!res.ok) throw new Error(`/test/click HTTP ${res.status}`);
};

/**
 * Delete a stored message row, simulating an ingest write that was lost. Used to
 * prove the history backfill puts it back.
 */
export const deleteStoredMessage = (messageId: number): Promise<void> =>
    new Promise((resolve, reject) => {
        const db = new sqlite3.Database(TEST_DB_PATH, sqlite3.OPEN_READWRITE, (openErr) => {
            if (openErr) return reject(openErr);
            db.run(
                'DELETE FROM telegram_messages WHERE chatId = ? AND messageId = ?',
                [TEST_CHAT_ID, messageId],
                (err) => {
                    db.close();
                    if (err) reject(err);
                    else resolve();
                }
            );
        });
    });

/** One entry of a reply's tool usage line (AgentStats.toolUsage) */
export interface ToolUsageEntry {
    name: string;
    count: number;
}

/** A version's image, enough to tell two pictures apart without keeping the bytes */
export interface StoredImage {
    bytes: number;
    sha256: string;
}

export interface FinalBotResponse {
    firstMessageId: number;
    buttonState: string;
    text: string;
    thinkingText?: string;
    errorMessage?: string;
    messageIds: number[];
    /** The version's last message: the one with the buttons, the picture when there is one */
    currentMessageId: number;
    image?: StoredImage;
    imageCaption?: string;
    toolUsage: ToolUsageEntry[];
}

// The stored versions are JSON this harness did not write: read field by
// field rather than trusting a shape (src/db/botResponseDTO.ts ResponseVersion)
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const optionalString = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;

const numbersIn = (value: unknown): number[] =>
    listOf(value).filter((item): item is number => typeof item === 'number');

const toolUsageOf = (agentStats: unknown): ToolUsageEntry[] =>
    isRecord(agentStats)
        ? listOf(agentStats.toolUsage).flatMap((entry) =>
              isRecord(entry) && typeof entry.name === 'string' && typeof entry.count === 'number'
                  ? [{ name: entry.name, count: entry.count }]
                  : []
          )
        : [];

const imageOf = (imageBase64: unknown): StoredImage | undefined => {
    if (typeof imageBase64 !== 'string' || imageBase64.length === 0) return undefined;
    const data = Buffer.from(imageBase64, 'base64');
    return { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
};

const toFinalResponse = (row: BotResponseRow): FinalBotResponse => {
    // versions is stored double-JSON-encoded by the DTO layer
    const decoded: unknown = JSON.parse(row.versions);
    const last = listOf(typeof decoded === 'string' ? JSON.parse(decoded) : decoded).at(-1);
    if (!isRecord(last)) throw new Error('bot_responses row has no versions');

    const messageIds = numbersIn(last.messageIds);
    return {
        firstMessageId: row.messageId,
        buttonState: row.buttonState,
        text: optionalString(last.text) ?? '',
        thinkingText: optionalString(last.thinkingText),
        errorMessage: optionalString(last.errorMessage),
        messageIds,
        currentMessageId:
            typeof last.currentMessageId === 'number'
                ? last.currentMessageId
                : (messageIds.at(-1) ?? row.messageId),
        image: imageOf(last.imageBase64),
        imageCaption: optionalString(last.imageCaption),
        toolUsage: toolUsageOf(last.agentStats),
    };
};

/**
 * Poll the test bot's DB until the response to our trigger message reaches a
 * final state (buttonState != processing). Throws on timeout.
 */
export const waitForBotResponse = async (
    userMessageId: number,
    timeoutMs = 120_000
): Promise<FinalBotResponse> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const row = await queryOne<BotResponseRow>(
            'SELECT messageId, userMessageId, buttonState, versions FROM bot_responses WHERE chatId = ? AND userMessageId = ?',
            [TEST_CHAT_ID, userMessageId]
        );
        if (row && row.buttonState !== 'processing') return toFinalResponse(row);
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`Timed out waiting for bot response to msg ${userMessageId}`);
};

/** Poll until the response row reaches the given buttonState. Throws on timeout. */
export const waitForButtonState = async (
    userMessageId: number,
    buttonState: string,
    timeoutMs = 30_000
): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const row = await queryOne<BotResponseRow>(
            'SELECT buttonState FROM bot_responses WHERE chatId = ? AND userMessageId = ?',
            [TEST_CHAT_ID, userMessageId]
        );
        if (row && row.buttonState === buttonState) return;
        await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error(`Timed out waiting for buttonState=${buttonState} on msg ${userMessageId}`);
};

/** Poll until autoSave persists our user message; returns the stored text
 *  (markdown since 0.3.x — formatting entities survive into the DB). */
export const waitForStoredMessage = async (
    messageId: number,
    timeoutMs = 20_000
): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const row = await queryOne<{ text: string }>(
            'SELECT text FROM telegram_messages WHERE chatId = ? AND messageId = ?',
            [TEST_CHAT_ID, messageId]
        );
        if (row) return row.text;
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Timed out waiting for stored message ${messageId}`);
};

/** Poll until autoSave stores OCR text for a message; returns it. Throws on timeout. */
export const waitForStoredOcrText = async (
    messageId: number,
    timeoutMs = 90_000
): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const row = await queryOne<{ ocrText: string | null }>(
            'SELECT ocrText FROM telegram_messages WHERE chatId = ? AND messageId = ?',
            [TEST_CHAT_ID, messageId]
        );
        if (row?.ocrText) return row.ocrText;
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`Timed out waiting for OCR text of message ${messageId}`);
};

/**
 * Poll until the bot has stored a picture of its own replying to `replyToId`.
 * That row is the real deliverable of /pic: it is what lets the next command
 * use the result as a reference image. Returns its message id.
 */
export const waitForStoredImageReply = async (
    replyToId: number,
    timeoutMs = 180_000
): Promise<number> => waitForStoredMediaReply(replyToId, { timeoutMs, noun: 'picture' });

/**
 * The generated media the bot stored as a reply to `replyToId`. `mimePrefix`
 * separates a `/vid` clip from a `/pic` result on a row that otherwise looks
 * identical.
 */
export const waitForStoredMediaReply = async (
    replyToId: number,
    options: { timeoutMs?: number; mimePrefix?: string; noun?: string } = {}
): Promise<number> => {
    const { timeoutMs = 180_000, mimePrefix, noun = 'result' } = options;
    const deadline = Date.now() + timeoutMs;
    const mimeClause = mimePrefix ? " AND fileMime LIKE ? || '%'" : '';
    const params = mimePrefix ? [TEST_CHAT_ID, replyToId, mimePrefix] : [TEST_CHAT_ID, replyToId];

    while (Date.now() < deadline) {
        const row = await queryOne<{ messageId: number; bytes: number }>(
            `SELECT messageId, length(file) AS bytes FROM telegram_messages
             WHERE chatId = ? AND replyToId = ? AND fromBotSelf = 1 AND file IS NOT NULL${mimeClause}`,
            params
        );
        if (row && row.bytes > 0) return row.messageId;
        await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw new Error(`Timed out waiting for a generated ${noun} replying to ${replyToId}`);
};

/** The ids a `/chat` message pulled into the context (its message_links rows) */
export const readLinkedMessageIds = async (
    commandMessageId: number
): Promise<number[]> => {
    const rows = await queryAll<{ linkedMessageId: number }>(
        'SELECT linkedMessageId FROM message_links WHERE chatId = ? AND sourceMessageId = ? ORDER BY linkedMessageId',
        [TEST_CHAT_ID, commandMessageId]
    );
    return rows.map((row) => row.linkedMessageId);
};

export interface StoredMessage {
    text: string | null;
    fileMime: string | null;
    /** Size of the file kept on the row itself; null when it has none */
    fileBytes: number | null;
}

/** A stored row as later contexts read it, without the file itself */
export const readStoredMessage = (messageId: number): Promise<StoredMessage | undefined> =>
    queryOne<StoredMessage>(
        'SELECT text, fileMime, length(file) AS fileBytes FROM telegram_messages WHERE chatId = ? AND messageId = ?',
        [TEST_CHAT_ID, messageId]
    );

/** Which of the given messages carry media: a file on the row or one in the media cache */
export const readMediaMessageIds = async (messageIds: readonly number[]): Promise<number[]> => {
    if (messageIds.length === 0) return [];
    const placeholders = messageIds.map(() => '?').join(', ');
    const rows = await queryAll<{ messageId: number }>(
        `SELECT messageId FROM telegram_messages
         WHERE chatId = ? AND messageId IN (${placeholders}) AND (file IS NOT NULL OR fileUniqueId IS NOT NULL)
         ORDER BY messageId`,
        [TEST_CHAT_ID, ...messageIds]
    );
    return rows.map((row) => row.messageId);
};

/**
 * The spinner lines StreamingEditor rotates through while a reply is still
 * being written (statusData in src/telegram/streaming-editor.ts).
 */
const SPINNER_LINES: ReadonlySet<string> = new Set([
    '✽ Thinking...',
    '◐ Processing...',
    '◑ Analyzing...',
    '◒ Computing...',
    '◓ Synthesizing...',
    '● Reasoning...',
    '◯ Generating...',
    '◈ Composing...',
    '◇ Reflecting...',
    '◆ Iterating...',
    '▲ Optimizing...',
    '▼ Finalizing...',
]);

/**
 * What replaces the spinner while a tool runs: the tool's statusText
 * ("🎨 正在画图…", "📨 正在发短信…" in src/reply/tools/) or the generic
 * "⚙ 正在调用 <name>…" of src/ai/tools/turn-tools.ts. A reply showing one is
 * mid-turn, not finished.
 */
const TOOL_STATUS_LINE = /^\S+ 正在.+…$/u;

/** A continuation message before its first edit (src/reply/response-handler.ts) */
const CONTINUATION_PLACEHOLDER = 'continued';

/**
 * Whether a bot message still shows a status line. The editor always appends
 * it as the last line and final edits never carry one, so only the last line
 * is looked at: a spinner symbol inside the reply itself is not a status.
 */
export const showsStatusLine = (text: string): boolean => {
    const lastLine = text.trimEnd().split('\n').at(-1) ?? '';
    return (
        SPINNER_LINES.has(lastLine) ||
        TOOL_STATUS_LINE.test(lastLine) ||
        text === CONTINUATION_PLACEHOLDER
    );
};

/** The visible message is its final render, not a streaming or tool-running one */
export const hasFinishedStreaming = (message: DriverMessage): boolean =>
    !showsStatusLine(message.text);

/** Simple assertion helper that keeps going readable in the case runner */
export const expect = (condition: boolean, description: string): void => {
    if (!condition) throw new Error(`Assertion failed: ${description}`);
    console.log(`    ✓ ${description}`);
};

/** expect() for a value the rest of the case needs: narrows it to present */
export function expectPresent<T>(value: T | undefined, description: string): asserts value is T {
    expect(value !== undefined, description);
}

export const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));
