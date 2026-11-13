/**
 * The scratch directory of one test process. The harness creates and removes
 * its own; the runner removes the one a test it had to kill left behind.
 *
 * It is kept in memory where the system offers a place for that. sqlite waits
 * for every commit to reach the disk, and on a real disk that wait is a large
 * part of the time a test file takes.
 */
import { accessSync, constants, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MEMORY_DIRECTORY = '/dev/shm';
const NAME_PREFIX = 'k-on-bot-offline-';

const isWritableDirectory = (path: string): boolean => {
    try {
        accessSync(path, constants.W_OK | constants.X_OK);
        return true;
    } catch {
        return false;
    }
};

const SCRATCH_ROOT = isWritableDirectory(MEMORY_DIRECTORY) ? MEMORY_DIRECTORY : tmpdir();

export const scratchDirectoryOf = (processId: number): string => join(SCRATCH_ROOT, `${NAME_PREFIX}${processId}`);

export const removeScratchDirectoryOf = (processId: number): void => {
    rmSync(scratchDirectoryOf(processId), { recursive: true, force: true });
};

const isRunning = (processId: number): boolean => {
    try {
        // Signal 0 sends nothing: it only asks whether the process is there
        process.kill(processId, 0);
        return true;
    } catch (error) {
        // EPERM: there, and somebody else's
        return error instanceof Error && 'code' in error && error.code === 'EPERM';
    }
};

/**
 * Removes the directories of processes that are gone: a test or a runner that
 * was killed could not remove its own, and memory is not cleaned up the way
 * the temp directory is.
 */
export const removeAbandonedScratchDirectories = (): void => {
    for (const entry of readdirSync(SCRATCH_ROOT)) {
        if (!entry.startsWith(NAME_PREFIX)) continue;
        const processId = Number(entry.slice(NAME_PREFIX.length));
        if (Number.isInteger(processId) && !isRunning(processId)) removeScratchDirectoryOf(processId);
    }
};
