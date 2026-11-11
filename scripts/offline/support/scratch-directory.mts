/**
 * The scratch directory of one test process. The harness creates and removes
 * its own; the runner removes the one a test it had to kill left behind.
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const scratchDirectoryOf = (processId: number): string => join(tmpdir(), `k-on-bot-offline-${processId}`);

export const removeScratchDirectoryOf = (processId: number): void => {
    rmSync(scratchDirectoryOf(processId), { recursive: true, force: true });
};
