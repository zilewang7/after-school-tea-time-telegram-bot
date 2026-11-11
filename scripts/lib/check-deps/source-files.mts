import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

const SOURCE_FILE = /\.(ts|tsx|mts|cts)$/;
const DECLARATION_FILE = /\.d\.(ts|mts|cts)$/;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist']);

/** Repository-relative paths of the TypeScript files below one directory */
const listDirectory = (root: string, directory: string, paths: string[]): void => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
        const path = posix.join(directory, entry.name);
        // Symbolic links are skipped too: a linked node_modules is not ours to check
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) listDirectory(root, path, paths);
        } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !DECLARATION_FILE.test(entry.name)) {
            paths.push(path);
        }
    }
};

/** Path → text of every TypeScript file below the given directories, in a stable order */
export const readSourceFiles = (root: string, directories: readonly string[]): Map<string, string> => {
    const paths: string[] = [];
    for (const directory of directories) listDirectory(root, directory, paths);
    paths.sort();
    return new Map(paths.map((path) => [path, readFileSync(join(root, path), 'utf8')] as const));
};
