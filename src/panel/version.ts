/**
 * The commit the running code was built from, read once at startup.
 *
 * The deploy script writes it next to the compiled code (dist/BUILD_COMMIT),
 * and that file wins: the checkout is fetched before the build, so after a
 * failed build git already points at a commit that is not what is running.
 * Without the file (a run straight from src/, the test container) git is
 * asked; null when that fails too.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** The repository root, from src/panel/ or dist/panel/ alike */
const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** dist/BUILD_COMMIT in a deployed build */
const BUILD_COMMIT_FILE = fileURLToPath(new URL('../BUILD_COMMIT', import.meta.url));
const GIT_TIMEOUT_MS = 3000;
const SHORT_HASH_PATTERN = /^[0-9a-f]{4,40}$/;

const readBuildCommit = async (path: string): Promise<string | null> => {
    try {
        const recorded = (await readFile(path, 'utf8')).trim();
        return SHORT_HASH_PATTERN.test(recorded) ? recorded : null;
    } catch {
        return null;
    }
};

const readGitHead = (): Promise<string | null> =>
    new Promise((resolve) => {
        execFile(
            'git',
            ['rev-parse', '--short', 'HEAD'],
            { cwd: REPOSITORY_ROOT, timeout: GIT_TIMEOUT_MS },
            (error, stdout) => {
                const hash = String(stdout).trim();
                resolve(error === null && SHORT_HASH_PATTERN.test(hash) ? hash : null);
            }
        );
    });

/** `buildCommitFile` is a parameter for tests only */
export const readCodeVersion = async (buildCommitFile: string = BUILD_COMMIT_FILE): Promise<string | null> =>
    (await readBuildCommit(buildCommitFile)) ?? (await readGitHead());
