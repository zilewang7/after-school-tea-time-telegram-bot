/**
 * Runs one offline test file in a process of its own and captures its output.
 */
import { endProcessGroup } from './process-groups.mts';
import { spawnTestProcess } from './test-process.mts';

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
    /** Variables the test gets on top of the runner's own environment */
    extraEnvironment?: Readonly<Record<string, string>>;
}

/** What a test process is started with, in a process of its own or in a shared worker */
export const testEnvironment = (
    caseFilter: string | undefined,
    extraEnvironment: Readonly<Record<string, string>> = {}
): NodeJS.ProcessEnv => {
    // The log keeps every assertion; the terminal only gets the summary
    const environment: NodeJS.ProcessEnv = { ...process.env, ...extraEnvironment, OFFLINE_VERBOSE: '1' };
    if (caseFilter !== undefined) environment.OFFLINE_GREP = caseFilter;
    return environment;
};

export const runFile = (file: string, options: RunFileOptions): Promise<FileRun> =>
    new Promise((resolve) => {
        const startedAt = performance.now();
        const child = spawnTestProcess(file, {
            repositoryRoot: options.repositoryRoot,
            environment: testEnvironment(options.caseFilter, options.extraEnvironment),
            logPath: options.logPath,
            logFlags: 'w',
            channel: false,
        });
        const groupId = child.pid;

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
            // A helper the test started and did not stop must not outlive it
            if (groupId !== undefined) endProcessGroup(groupId);
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
