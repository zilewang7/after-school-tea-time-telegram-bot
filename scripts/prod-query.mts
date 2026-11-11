/**
 * Read-only query against the production database, run inside its container.
 *
 *   npx tsx scripts/prod-query.mts --tables
 *   npx tsx scripts/prod-query.mts --schema telegram_messages
 *   npx tsx scripts/prod-query.mts "SELECT chatId, messageId, userName FROM telegram_messages ORDER BY date DESC LIMIT 5"
 *   npx tsx scripts/prod-query.mts --limit 500 --full "SELECT …"
 *
 * Why through the container: production mounts the single file
 * ./database.sqlite and keeps its write-ahead log on the container's own
 * filesystem. A process on the host sees a stale file without the log, and
 * opening it there can corrupt it. Never open that file on the host.
 *
 * The database is opened read-only with `query_only` on, so a statement that
 * writes fails. At most --limit rows come back (default 200), a blob prints as
 * its size, and long text is cut unless --full is given. Select `length(file)`
 * rather than a blob column: the rows are loaded inside the production process
 * space before they are trimmed.
 */
import { spawnSync } from 'node:child_process';

const CONTAINER = 'k-on-bot';
const DEFAULT_ROW_LIMIT = 200;
const DEFAULT_TIMEOUT_SECONDS = 30;
const TEXT_PREVIEW_LENGTH = 300;

interface QueryRequest {
    sql: string;
    rowLimit: number;
    timeoutMs: number;
    fullText: boolean;
    textPreviewLength: number;
}

/**
 * Runs inside the container (plain CommonJS, node -e). Reads the request from
 * argv as base64 JSON so no SQL ever passes through a shell.
 */
const IN_CONTAINER_PROGRAM = `
const sqlite3 = require('/app/k-on-bot/node_modules/sqlite3');
const request = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
const fail = (message) => { console.error(message); process.exit(1); };
const printable = (value) => {
    if (Buffer.isBuffer(value)) return '<blob ' + value.length + ' bytes>';
    if (typeof value === 'string' && !request.fullText && value.length > request.textPreviewLength) {
        return value.slice(0, request.textPreviewLength) + '… (' + value.length + ' chars)';
    }
    return value;
};
const database = new sqlite3.Database('/app/k-on-bot/database.sqlite', sqlite3.OPEN_READONLY, (openError) => {
    if (openError) fail(openError.message);
    database.configure('busyTimeout', 5000);
    setTimeout(() => { database.interrupt(); fail('query timed out'); }, request.timeoutMs);
    database.exec('PRAGMA query_only = ON', (pragmaError) => {
        if (pragmaError) fail(pragmaError.message);
        database.all(request.sql, (queryError, rows) => {
            if (queryError) fail(queryError.message);
            const shown = rows.slice(0, request.rowLimit);
            for (const row of shown) {
                const line = {};
                for (const [column, value] of Object.entries(row)) line[column] = printable(value);
                console.log(JSON.stringify(line));
            }
            if (rows.length > shown.length) console.error('(more rows exist; raise --limit or narrow the query)');
            database.close(() => process.exit(0));
        });
    });
});
`;

const usage = (): never => {
    console.error(
        'usage: npx tsx scripts/prod-query.mts [--limit N] [--timeout SECONDS] [--full] (--tables | --schema TABLE | "SQL")'
    );
    process.exit(2);
};

const positiveInteger = (raw: string | undefined): number => {
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : usage();
};

const TABLES_SQL = "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name";

const schemaSql = (table: string): string => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return usage();
    return `SELECT type, name, sql FROM sqlite_master WHERE tbl_name = '${table}' ORDER BY type DESC, name`;
};

/**
 * Caps the rows inside SQLite, so a forgotten LIMIT does not load a whole
 * table into the container's memory. Only a plain query can be wrapped; a
 * PRAGMA or EXPLAIN runs as written.
 */
const withRowCap = (sql: string, rowLimit: number): string => {
    const statement = sql.trim().replace(/;+\s*$/, '');
    if (!/^(select|with)\b/i.test(statement)) return statement;
    // One more than the limit, so the program can tell that rows were cut
    return `SELECT * FROM (${statement}) LIMIT ${rowLimit + 1}`;
};

const parseArguments = (argv: string[]): QueryRequest => {
    let rowLimit = DEFAULT_ROW_LIMIT;
    let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
    let fullText = false;
    let sql: string | undefined;

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index] ?? '';
        if (argument === '--limit') rowLimit = positiveInteger(argv[(index += 1)]);
        else if (argument === '--timeout') timeoutSeconds = positiveInteger(argv[(index += 1)]);
        else if (argument === '--full') fullText = true;
        else if (argument === '--tables') sql = TABLES_SQL;
        else if (argument === '--schema') sql = schemaSql(argv[(index += 1)] ?? usage());
        else if (argument.startsWith('--') || sql !== undefined) usage();
        else sql = argument;
    }
    if (sql === undefined || sql.trim() === '') return usage();

    return {
        sql: withRowCap(sql, rowLimit),
        rowLimit,
        timeoutMs: timeoutSeconds * 1000,
        fullText,
        textPreviewLength: TEXT_PREVIEW_LENGTH,
    };
};

const request = parseArguments(process.argv.slice(2));
const encodedRequest = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
const outcome = spawnSync('docker', ['exec', CONTAINER, 'node', '-e', IN_CONTAINER_PROGRAM, encodedRequest], {
    stdio: 'inherit',
});
if (outcome.error) {
    console.error(`could not run docker: ${outcome.error.message}`);
    process.exit(1);
}
process.exitCode = outcome.status ?? 1;
