/**
 * Starts the Node process tests run in: a test file's own, or a shared worker.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { trackProcessGroup } from './process-groups.mts';

export interface TestProcessOptions {
    repositoryRoot: string;
    environment: NodeJS.ProcessEnv;
    /** Receives the stdout and stderr of the process */
    logPath: string;
    /** 'w' starts the log anew, 'a' adds to it */
    logFlags: 'w' | 'a';
    /** Give the process an IPC channel to the runner */
    channel: boolean;
}

/** `entry` is what Node runs: a path, absolute or relative to the repository root */
export const spawnTestProcess = (entry: string, options: TestProcessOptions): ChildProcess => {
    // One file descriptor for stdout and stderr: the log then holds the lines
    // in the order they were written. Two pipes would interleave them by
    // arrival, and a failure message could land under the wrong case.
    const logDescriptor = openSync(options.logPath, options.logFlags);
    // `node --import tsx` instead of the tsx binary: the binary starts the
    // test as a grandchild, which a kill of the child would leave running
    const child = spawn(process.execPath, ['--import', 'tsx', entry], {
        cwd: options.repositoryRoot,
        env: options.environment,
        // The leader of a process group of its own, see process-groups.mts
        detached: true,
        stdio: options.channel
            ? ['ignore', logDescriptor, logDescriptor, 'ipc']
            : ['ignore', logDescriptor, logDescriptor],
    });
    // The child has its own copies now
    closeSync(logDescriptor);
    if (child.pid !== undefined) trackProcessGroup(child.pid);
    return child;
};
