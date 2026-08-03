/**
 * One-shot migration: retire `telegram_messages.replies`, add `chatCommand`.
 *
 *   pnpm tsx scripts/migrate/2026-0803-message-links.mts [--db path] [--no-vacuum]
 *
 * Run with the bot stopped. The `message_links` table itself is created by the
 * app's own `sequelize.sync()` on the next start — only the column changes need
 * to be explicit, because sync's SQLite column removal goes through an opaque
 * table rebuild.
 *
 * `DROP COLUMN` rewrites the table anyway, so a VACUUM rides along: the 1.2GB
 * production file holds only a few thousand rows, the rest being free pages left
 * behind by autoClear deleting media blobs, and nothing ever reclaimed them.
 */
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';

const args = process.argv.slice(2);
const dbPath = args.includes('--db') ? args[args.indexOf('--db') + 1] : 'database.sqlite';
const skipVacuum = args.includes('--no-vacuum');

if (!dbPath) {
    console.error('usage: tsx scripts/migrate/2026-0803-message-links.mts [--db path] [--no-vacuum]');
    process.exit(1);
}

const sizeMb = (path: string): string => `${(statSync(path).size / 1024 / 1024).toFixed(1)}MB`;

const columnsOf = (db: DatabaseSync, table: string): string[] =>
    db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => String((row as { name: unknown }).name));

const started = process.hrtime.bigint();
const elapsed = (): string => `${Number(process.hrtime.bigint() - started) / 1e9}s`;

console.log(`[migrate] ${dbPath} (${sizeMb(dbPath)})`);

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = OFF');

const columns = columnsOf(db, 'telegram_messages');
if (!columns.length) {
    console.error('[migrate] telegram_messages does not exist — wrong database?');
    process.exit(1);
}

// Both steps are individually conditional, so a re-run (or a resume after an
// interrupted VACUUM) is a no-op instead of an error.
if (columns.includes('replies')) {
    const attached = db
        .prepare(`SELECT COUNT(*) AS c FROM telegram_messages WHERE replies IS NOT NULL AND replies NOT IN ('[]', '"[]"')`)
        .get() as { c: number };
    console.log(`[migrate] dropping replies (${attached.c} row(s) still carry one; not migrated by design)`);
    db.exec('ALTER TABLE telegram_messages DROP COLUMN replies');
} else {
    console.log('[migrate] replies already gone');
}

if (!columns.includes('chatCommand')) {
    console.log('[migrate] adding chatCommand');
    db.exec('ALTER TABLE telegram_messages ADD COLUMN chatCommand TEXT');
} else {
    console.log('[migrate] chatCommand already present');
}

console.log(`[migrate] columns now: ${columnsOf(db, 'telegram_messages').join(', ')}`);

if (skipVacuum) {
    console.log('[migrate] skipping VACUUM as asked');
} else {
    console.log('[migrate] VACUUM…');
    db.exec('VACUUM');
}

db.close();

console.log(`[migrate] done in ${elapsed()} — ${dbPath} is now ${sizeMb(dbPath)}`);
