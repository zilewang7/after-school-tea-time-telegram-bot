import { Sequelize } from '@sequelize/core';
import { SqliteDialect } from '@sequelize/sqlite3';

/**
 * How long a blocked writer waits for the lock before giving up. The driver's
 * default is a single second, and the hourly cleanup has been observed holding
 * the write lock for 26s — two incoming messages hit SQLITE_BUSY in that window
 * and were dropped for good, leaving holes the reply tree can never fill.
 */
const BUSY_TIMEOUT_MS = 30_000;

export const sequelize = new Sequelize({
    dialect: SqliteDialect,
    storage: process.env.DB_PATH || 'database.sqlite',
});

/**
 * The one part of the raw driver handle we need. Sequelize types the hook's
 * argument as an opaque connection, so the capability is probed instead of
 * assumed — an upstream driver swap then degrades to a warning, not a crash.
 */
interface ConfigurableConnection {
    configure(option: 'busyTimeout', value: number): void;
}

const canConfigure = (connection: unknown): connection is ConfigurableConnection =>
    typeof connection === 'object'
    && connection !== null
    && 'configure' in connection
    && typeof connection.configure === 'function';

let warnedAboutMissingConfigure = false;

/**
 * busy_timeout is per connection, so every connection the pool opens has to be
 * configured — setting it through a query would only reach whichever pooled
 * connection happened to run that query.
 */
sequelize.hooks.addListener('afterConnect', (connection) => {
    if (!canConfigure(connection)) {
        if (!warnedAboutMissingConfigure) {
            warnedAboutMissingConfigure = true;
            console.warn('[db] driver connection cannot be configured; busy_timeout stays at the driver default');
        }
        return;
    }
    connection.configure('busyTimeout', BUSY_TIMEOUT_MS);
});

/**
 * Switch the database to WAL, once, before the schema sync.
 *
 * In the default rollback-journal mode a writer locks the whole file (readers
 * included) and every page it touches is first copied into the journal — on a
 * multi-hundred-MB database full of media blobs that turns a small delete into
 * seconds of exclusive I/O. WAL lets readers through and appends instead of
 * copying, which keeps the lock window short enough for the timeout above to be
 * a safety net rather than the normal case.
 *
 * The mode lives in the database header, so this is a no-op from the second run
 * on; it still runs every start so a restored or rebuilt file gets it too.
 */
export const enableWriteAheadLog = async (): Promise<void> => {
    const [rows] = await sequelize.query('PRAGMA journal_mode = WAL');
    console.log('[db] journal mode:', JSON.stringify(rows));
};
