/**
 * Read-only access to the production container, shared by the query command
 * and the release checks. Everything here runs through `docker exec`.
 *
 * Why not the database file on the host: production mounts the single file
 * ./database.sqlite and keeps its write-ahead log on the container's own
 * filesystem. A host process sees a stale file without the log, and opening
 * it there can corrupt it.
 */
import { spawnSync } from 'node:child_process';

export const PRODUCTION_CONTAINER = 'k-on-bot';
const PANEL_PORT = 8080;

export interface ProductionQuery {
    sql: string;
    /** Rows printed at most */
    rowLimit: number;
    timeoutMs: number;
    /** Print text columns whole instead of a preview */
    fullText: boolean;
}

const TEXT_PREVIEW_LENGTH = 300;

/**
 * Runs inside the container (plain CommonJS, node -e). Takes the request from
 * argv as base64 JSON so no SQL ever passes through a shell. The database is
 * opened read-only with query_only on; one JSON object per row goes to stdout.
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

const dockerExecArguments = (query: ProductionQuery): string[] => {
    const request = { ...query, sql: withRowCap(query.sql, query.rowLimit), textPreviewLength: TEXT_PREVIEW_LENGTH };
    const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
    return ['exec', PRODUCTION_CONTAINER, 'node', '-e', IN_CONTAINER_PROGRAM, encoded];
};

/** Runs the query and lets its output go straight to the terminal; returns the exit code */
export const printProductionQuery = (query: ProductionQuery): number => {
    const outcome = spawnSync('docker', dockerExecArguments(query), { stdio: 'inherit' });
    if (outcome.error) {
        console.error(`could not run docker: ${outcome.error.message}`);
        return 1;
    }
    return outcome.status ?? 1;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** Runs the query and returns its rows; throws when the query fails */
export const queryProduction = (sql: string, rowLimit = 200): Record<string, unknown>[] => {
    const outcome = spawnSync('docker', dockerExecArguments({ sql, rowLimit, timeoutMs: 30_000, fullText: true }), {
        encoding: 'utf8',
    });
    if (outcome.error) throw new Error(`could not run docker: ${outcome.error.message}`);
    if (outcome.status !== 0) throw new Error(`production query failed: ${outcome.stderr.trim()}`);
    return outcome.stdout
        .split('\n')
        .filter((line) => line !== '')
        .map((line): unknown => JSON.parse(line))
        .filter(isRecord);
};

export interface LiveHealth {
    /** Short commit hash of the running build; null when the bot could not tell */
    version: string | null;
    startedAt: string | null;
}

/** What the running bot reports about itself; null while it is not answering */
export const readLiveHealth = (): LiveHealth | null => {
    const outcome = spawnSync(
        'docker',
        ['exec', PRODUCTION_CONTAINER, 'wget', '-qO-', '-T', '5', `http://127.0.0.1:${PANEL_PORT}/api/health`],
        { encoding: 'utf8' }
    );
    if (outcome.status !== 0) return null;
    try {
        const body: unknown = JSON.parse(outcome.stdout);
        if (!isRecord(body)) return null;
        return {
            version: typeof body.version === 'string' ? body.version : null,
            startedAt: typeof body.startedAt === 'string' ? body.startedAt : null,
        };
    } catch {
        return null;
    }
};
