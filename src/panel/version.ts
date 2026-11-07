/**
 * The running code's short commit hash, read once at startup. null when git
 * is unavailable (the test image has none) or the checkout is not a repo.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The repository root, from src/panel/ or dist/panel/ alike */
const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const GIT_TIMEOUT_MS = 3000;
const SHORT_HASH_PATTERN = /^[0-9a-f]{4,40}$/;

export const readCodeVersion = (): Promise<string | null> =>
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
