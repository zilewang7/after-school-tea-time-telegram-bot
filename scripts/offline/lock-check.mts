/**
 * Regression test for the incident that dropped messages 1074050/1074051:
 * another writer held the write lock for 26s, the driver's default 1s
 * busy_timeout expired, and the INSERT died — permanently losing the message.
 *
 * Run: pnpm test:lock
 *
 * Kept out of `pnpm test:offline` because it spawns a second process and spends
 * a few seconds deliberately blocked.
 */
import { spawn } from 'node:child_process';
import {
    setupOfflineDb,
    expect,
    reportResults,
    runCase,
    OFFLINE_CHAT_ID,
    takeMessageId,
    type CaseResult,
} from './harness.mts';

/** How long the competing process keeps the write lock */
const LOCK_HOLD_MS = 3000;

const { Message, saveMessage } = await setupOfflineDb();
const { sequelize } = await import('../../src/db/config.js');

interface HeldLock {
    /** Settles when the competing writer has committed and exited */
    released: Promise<void>;
}

/**
 * Hold SQLite's write lock from a separate process (a second connection in this
 * one would be just as valid, but a real process rules out any doubt that the
 * lock is genuinely contended). Resolves once the lock is actually held.
 */
const holdWriteLock = (): Promise<HeldLock> =>
    new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
            '-e',
            `const { DatabaseSync } = require('node:sqlite');
             const db = new DatabaseSync(process.argv[1]);
             db.exec('BEGIN IMMEDIATE');
             db.exec("UPDATE telegram_messages SET userName = userName");
             process.stdout.write('locked');
             setTimeout(() => { db.exec('COMMIT'); process.exit(0); }, ${LOCK_HOLD_MS});`,
            process.env.DB_PATH ?? '',
        ]);

        // Attached now, not on demand: the locker exits the moment it commits,
        // which is the same moment the blocked write returns.
        const released = new Promise<void>((done) => child.on('exit', () => done()));

        let locked = false;
        child.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString().trim();
            if (!text.includes('ExperimentalWarning') && !text.includes('trace-warnings')) {
                console.error(`    [locker] ${text}`);
            }
        });
        child.stdout.on('data', (chunk: Buffer) => {
            if (chunk.toString().includes('locked')) {
                locked = true;
                resolve({ released });
            }
        });
        child.on('error', reject);
        // Without this a crashed locker would leave the await hanging forever
        child.on('exit', (code) => {
            if (!locked) reject(new Error(`locker exited (code ${code}) before taking the lock`));
        });
    });

const results: CaseResult[] = [];

results.push(await runCase('the database is in WAL mode with a long busy timeout', async () => {
    const [journalRows] = await sequelize.query('PRAGMA journal_mode');
    expect(
        JSON.stringify(journalRows).includes('wal'),
        `journal_mode is wal (got ${JSON.stringify(journalRows)})`
    );
    const [timeoutRows] = await sequelize.query('PRAGMA busy_timeout');
    expect(
        JSON.stringify(timeoutRows).includes('30000'),
        `busy_timeout is 30000 on a pooled connection (got ${JSON.stringify(timeoutRows)})`
    );
}));

results.push(await runCase('a message still lands while another writer holds the lock', async () => {
    // Seed one row so the locker's UPDATE has something to touch
    await saveMessage({
        chatId: OFFLINE_CHAT_ID,
        messageId: takeMessageId(),
        userId: 1,
        date: new Date(),
        userName: 'seed',
        message: 'seed',
    });

    const lock = await holdWriteLock();
    const messageId = takeMessageId();
    const startedAt = Date.now();

    await saveMessage({
        chatId: OFFLINE_CHAT_ID,
        messageId,
        userId: 2,
        date: new Date(),
        userName: 'blocked writer',
        message: 'written while the lock was held',
    });

    const elapsedMs = Date.now() - startedAt;
    await lock.released;

    const stored = await Message.findOne({ where: { chatId: OFFLINE_CHAT_ID, messageId } });
    expect(stored !== null, `the message was stored despite the lock (waited ${elapsedMs}ms)`);
    expect(
        elapsedMs > LOCK_HOLD_MS * 0.5,
        `it really did wait for the lock rather than winning a race (${elapsedMs}ms)`
    );
}));

reportResults(results);
await sequelize.close();
