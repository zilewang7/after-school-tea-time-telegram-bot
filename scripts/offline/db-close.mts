/**
 * The shutdown ends with closeDatabase (src/db/config.ts), which leaves nothing
 * in the write-ahead log.
 *
 * Production mounts the database file alone; the log sits in the container's
 * own layer and is gone when the container is recreated. These cases look at
 * the file the way such a container finds it: a copy of the file, without the
 * log next to it.
 */
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sqlite3 from 'sqlite3';
import { setupOfflineDb, expect, reportResults, runCase, type CaseResult } from './harness.mts';

// Keep idle connections open. With the harness default the pool closes them
// after a few milliseconds, and that close would merge the log before
// closeDatabase is asked to.
process.env.DB_POOL_IDLE_MS = '60000';

await setupOfflineDb();
const { sequelize, closeDatabase } = await import('../../src/db/config.js');

const databaseFile = process.env.DB_PATH ?? '';
const logFile = `${databaseFile}-wal`;
const fileAlone = join(dirname(databaseFile), 'file-alone.sqlite');

const sizeOf = (path: string): number => statSync(path, { throwIfNoEntry: false })?.size ?? 0;

/** Rows of the probe table in a copy of the database file taken without its log; 0 when the table is not there */
const probeRowsInFileAlone = (): Promise<number> => {
    copyFileSync(databaseFile, fileAlone);
    return new Promise((resolve, reject) => {
        const copy = new sqlite3.Database(fileAlone, sqlite3.OPEN_READONLY, (openError) => {
            if (openError) {
                reject(openError);
                return;
            }
            copy.get<{ count: number }>('SELECT COUNT(*) AS count FROM close_probe', (queryError, row) => {
                copy.close(() => resolve(queryError ? 0 : row.count));
            });
        });
    });
};

const results: CaseResult[] = [];

results.push(
    await runCase('a write is only in the log while the pool keeps a connection', async () => {
        await sequelize.query('CREATE TABLE close_probe (id INTEGER PRIMARY KEY, note TEXT)');
        await sequelize.query("INSERT INTO close_probe (note) VALUES ('written before the shutdown')");
        expect(sizeOf(logFile) > 0, `the log holds the write (${sizeOf(logFile)} bytes)`);
        expect((await probeRowsInFileAlone()) === 0, 'the database file alone does not have the row yet');
    })
);

results.push(
    await runCase('closeDatabase merges the log into the file and removes it', async () => {
        const closed = await closeDatabase();
        expect(closed, 'the database closed in time');
        expect(!existsSync(logFile), 'the log is gone');
        expect((await probeRowsInFileAlone()) === 1, 'the database file alone has the row');
    })
);

reportResults(results);
