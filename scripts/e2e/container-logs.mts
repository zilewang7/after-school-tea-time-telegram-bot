/**
 * The test container's log: the witness for what neither the database nor the
 * group read-back keeps — how many tools a turn was offered, how many
 * reference images a picture used, whether a picture went out as a photo.
 *
 * Read-only (`docker logs`); importing this module touches nothing, so the
 * container launcher can share the container name without loading the
 * harness and its .env.test lookups.
 */
import { spawn } from 'node:child_process';

export const TEST_CONTAINER = 'k-on-bot-test';

const linesOf = (chunks: readonly Buffer[]): string[] =>
    Buffer.concat(chunks).toString('utf8').split('\n');

/**
 * The container's log lines (stdout and stderr), only those after `sinceMs`
 * when given. null when docker cannot be asked: no such container, no
 * permission, no docker on this host.
 */
export const readContainerLogLines = (sinceMs?: number): Promise<string[] | null> =>
    new Promise((resolve) => {
        const sinceArgs = sinceMs === undefined ? [] : ['--since', (sinceMs / 1000).toFixed(3)];
        const child = spawn('docker', ['logs', ...sinceArgs, TEST_CONTAINER]);
        // Kept apart: a chunk of one stream may end mid-line
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
        child.on('error', () => resolve(null));
        child.on('close', (code) =>
            resolve(code === 0 ? [...linesOf(stdoutChunks), ...linesOf(stderrChunks)] : null)
        );
    });
