import { posix } from 'node:path';
import type { SourceFile, Statement } from '@typescript/typescript6';
import { ts } from './typescript.mts';
import { lineOf } from './parse-source.mts';

/** index files allowed to hold code, with the reason */
const INDEX_FILES_WITH_CODE: ReadonlyMap<string, string> = new Map([
    ['src/index.ts', 'the entry point of the bot: it has to start everything'],
    ['src/db/index.ts', 'the db facade: starts the schema sync (dbReady) and holds the message save and lookup queries'],
]);

export const isIndexFile = (path: string): boolean => /^index\.tsx?$/.test(posix.basename(path));

export const mayHoldCode = (path: string): boolean => INDEX_FILES_WITH_CODE.has(path);

/** Imports and `export … ` lists are re-exports; any other statement is code */
const isReExport = (statement: Statement): boolean =>
    ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isEmptyStatement(statement);

/** Lines of the statements in an index file that are not re-exports */
export const findIndexFileCode = (path: string, sourceFile: SourceFile): number[] => {
    if (!isIndexFile(path) || mayHoldCode(path)) return [];
    return sourceFile.statements.filter((statement) => !isReExport(statement)).map((statement) => lineOf(sourceFile, statement));
};
