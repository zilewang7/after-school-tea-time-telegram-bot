/**
 * Runs one offline test file in its own process group and captures its output.
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

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

const killProcessGroup = (groupId: number): void => {
    try {
        // A negative pid addresses the whole group: the test and anything it spawned
        process.kill(-groupId, 'SIGKILL');
    } catch {
        // Already gone
    }
};

export const killLiveTestProcesses = (): void => {
    for (const groupId of liveProcessGroups) killProcessGroup(groupId);
};

export const runFile = (file: string, options: RunFileOptions): Promise<FileRun> =>
    new Promise((resolve) => {
        const startedAt = performance.now();
        const log = createWriteStream(options.logPath);
        // The log keeps every assertion; the terminal only gets the summary
        const environment: NodeJS.ProcessEnv = { ...process.env, OFFLINE_VERBOSE: '1' };
        if (options.caseFilter !== undefined) environment.OFFLINE_GREP = options.caseFilter;

        // `node --import tsx` instead of the tsx binary: the binary starts the
        // test as a grandchild, which a kill of the child would leave running
        const child = spawn(process.execPath, ['--import', 'tsx', file], {
            cwd: options.repositoryRoot,
            env: environment,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const groupId = child.pid;
        if (groupId !== undefined) liveProcessGroups.add(groupId);

        child.stdout.pipe(log, { end: false });
        child.stderr.pipe(log, { end: false });

        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            if (groupId !== undefined) killProcessGroup(groupId);
        }, options.timeoutMs);

        let settled = false;
        const settle = (exitCode: number | null): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (groupId !== undefined) liveProcessGroups.delete(groupId);
            log.end(() => {
                resolve({
                    file,
                    logPath: options.logPath,
                    exitCode,
                    timedOut,
                    durationMs: performance.now() - startedAt,
                });
            });
        };
        // 'error' = the process never started; 'close' = it ended and its output is in
        child.once('error', () => settle(null));
        child.once('close', (exitCode) => settle(exitCode));
    });
