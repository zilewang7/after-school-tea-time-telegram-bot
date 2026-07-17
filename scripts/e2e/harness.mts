/**
 * E2E harness for driving the test bot (@WatchFirstBot) through real Telegram.
 *
 * Drive:  luoxu-api /test/send — the userbot posts a trigger message into the
 *         dedicated test group (server-side whitelisted to that group only).
 * Verify: primary — the test bot's own sqlite (bot_responses row keyed by our
 *         trigger message id; buttonState leaving 'processing' = final state);
 *         secondary — luoxu-api /test/messages MTProto read-back of what is
 *         actually visible in the group (text + entities).
 */
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

export const BOT_USERNAME = readEnvValue('BOT_USER_NAME');
export const BOT_USER_ID = Number(readEnvValue('BOT_USER_ID'));

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

const queryOne = <T>(sql: string, params: unknown[]): Promise<T | undefined> =>
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

export interface FinalBotResponse {
    firstMessageId: number;
    buttonState: string;
    text: string;
    thinkingText?: string;
    errorMessage?: string;
    messageIds: number[];
}

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
        if (row && row.buttonState !== 'processing') {
            // versions is stored double-JSON-encoded by the DTO layer
            const decoded: unknown = JSON.parse(row.versions);
            const versions = (
                typeof decoded === 'string' ? JSON.parse(decoded) : decoded
            ) as Array<{
                text: string;
                thinkingText?: string;
                errorMessage?: string;
                messageIds: number[];
            }>;
            const last = versions[versions.length - 1];
            if (!last) throw new Error('bot_responses row has no versions');
            return {
                firstMessageId: row.messageId,
                buttonState: row.buttonState,
                text: last.text,
                thinkingText: last.thinkingText,
                errorMessage: last.errorMessage,
                messageIds: last.messageIds,
            };
        }
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

/** Simple assertion helper that keeps going readable in the case runner */
export const expect = (condition: boolean, description: string): void => {
    if (!condition) throw new Error(`Assertion failed: ${description}`);
    console.log(`    ✓ ${description}`);
};

export const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));
