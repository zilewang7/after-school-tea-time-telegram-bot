/**
 * Runs one offline test file in its own process group and captures its output.
 */
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { removeScratchDirectoryOf } from './scratch-directory.mts';

export interface FileRun {
    /** Path relative to the repository root */
    file: string;
    logPath: string;
    /** null when the process was killed or could not be started */
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number;
}

export interface RunFileOptions {
    repositoryRoot: string;
    logPath: string;
    timeoutMs: number;
    /** Passed on as OFFLINE_GREP: only the cases whose name contains it run */
    caseFilter: string | undefined;
}

/** Every test process group still running, so an interrupted run can take them down */
const liveProcessGroups = new Set<number>();

/**
 * Ends a test and anything it started, and removes the scratch directory the
 * test could not remove itself. Harmless when the test has already ended.
 */
const endProcessGroup = (groupId: number): void => {
    try {
        // A negative pid addresses the whole group: the test and anything it spawned
        process.kill(-groupId, 'SIGKILL');
    } catch {
        // Nothing left in the group
    }
    // The group id is the pid of the test process, which names its scratch directory
    removeScratchDirectoryOf(groupId);
};

export const killLiveTestProcesses = (): void => {
    for (const groupId of liveProcessGroups) endProcessGroup(groupId);
};

export const runFile = (file: string, options: RunFileOptions): Promise<FileRun> =>
    new Promise((resolve) => {
        const startedAt = performance.now();
        // The log keeps every assertion; the terminal only gets the summary
        const environment: NodeJS.ProcessEnv = { ...process.env, OFFLINE_VERBOSE: '1' };
        if (options.caseFilter !== undefined) environment.OFFLINE_GREP = options.caseFilter;

        // One file descriptor for stdout and stderr: the log then holds the lines
        // in the order they were written. Two pipes would interleave them by
        // arrival, and a failure message could land under the wrong case.
        const logDescriptor = openSync(options.logPath, 'w');
        // `node --import tsx` instead of the tsx binary: the binary starts the
        // test as a grandchild, which a kill of the child would leave running
        const child = spawn(process.execPath, ['--import', 'tsx', file], {
            cwd: options.repositoryRoot,
            env: environment,
            detached: true,
            stdio: ['ignore', logDescriptor, logDescriptor],
        });
        // The child has its own copies now
        closeSync(logDescriptor);
        const groupId = child.pid;
        if (groupId !== undefined) liveProcessGroups.add(groupId);

        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            if (groupId !== undefined) endProcessGroup(groupId);
        }, options.timeoutMs);

        let settled = false;
        const settle = (exitCode: number | null): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (groupId !== undefined) {
                // A helper the test started and did not stop must not outlive it
                endProcessGroup(groupId);
                liveProcessGroups.delete(groupId);
            }
            resolve({
                file,
                logPath: options.logPath,
                exitCode,
                timedOut,
                durationMs: performance.now() - startedAt,
            });
        };
        // 'error' = the process never started; 'exit' = it ended. Not 'close':
        // nothing is read from the child, so there is no stream to wait for.
        child.once('error', () => settle(null));
        child.once('exit', (exitCode) => settle(exitCode));
    });
