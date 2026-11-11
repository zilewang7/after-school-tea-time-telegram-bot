/**
 * Read-only query against the production database, run inside its container
 * (never open ./database.sqlite on the host; scripts/lib/production.mts says why).
 *
 *   npx tsx scripts/prod-query.mts --tables
 *   npx tsx scripts/prod-query.mts --schema telegram_messages
 *   npx tsx scripts/prod-query.mts "SELECT chatId, messageId, userName FROM telegram_messages ORDER BY date DESC LIMIT 5"
 *   npx tsx scripts/prod-query.mts --limit 500 --full "SELECT …"
 *
 * The database is opened read-only with `query_only` on, so a statement that
 * writes fails. At most --limit rows come back (default 200), a blob prints as
 * its size, and long text is cut unless --full is given. Select `length(file)`
 * rather than a blob column: the rows are loaded inside the production process
 * space before they are trimmed.
 */
import { printProductionQuery, type ProductionQuery } from './lib/production.mts';

const DEFAULT_ROW_LIMIT = 200;
const DEFAULT_TIMEOUT_SECONDS = 30;

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

const parseArguments = (argv: string[]): ProductionQuery => {
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

    return { sql, rowLimit, timeoutMs: timeoutSeconds * 1000, fullText };
};

process.exitCode = printProductionQuery(parseArguments(process.argv.slice(2)));
