/**
 * Run the e2e suite against a test bot started just for it.
 *
 * The test bot shares a real Telegram group with people, so leaving it running
 * between test sessions means a second bot answering @mentions and reacting to
 * pictures for no reason. It also runs the mounted working tree, so a container
 * that has been up for days is running whatever the code looked like then.
 *
 * So: recreate it, wait until it is actually taking updates, run the suite,
 * stop it — including when the suite fails or the run is interrupted.
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

const CONTAINER = 'k-on-bot-test';
/** pnpm install + tsc + connect; ~40s observed, with room for a cold volume */
const STARTUP_TIMEOUT_MS = 240_000;

const run = (command: string, args: string[], quiet = false): Promise<number> =>
    new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: repoRoot,
            stdio: quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit',
        });
        child.on('error', reject);
        child.on('exit', (code) => resolve(code ?? 1));
    });

const capture = (command: string, args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: repoRoot });
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.on('error', reject);
        child.on('exit', () => resolve(output));
    });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const compose = (...args: string[]): Promise<number> =>
    run('docker', ['compose', '--profile', 'test', ...args]);

/** Wait until the container logs that it is connected, or explain what it said */
const waitUntilReady = async (): Promise<void> => {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const logs = await capture('docker', ['logs', CONTAINER, '--tail', '200']);
        if (logs.includes('Bot started as @')) return;
        if (/error TS\d+|ELIFECYCLE|Cannot find module/.test(logs)) {
            throw new Error(`${CONTAINER} failed to start:\n${logs.slice(-2000)}`);
        }
        await sleep(3000);
    }
    throw new Error(`${CONTAINER} did not report "Bot started" within ${STARTUP_TIMEOUT_MS / 1000}s`);
};

const stopContainer = async (): Promise<void> => {
    console.log(`\n⏹  stopping ${CONTAINER}`);
    await compose('stop', CONTAINER);
};

const main = async (): Promise<void> => {
    console.log(`▶ starting ${CONTAINER} on the current working tree`);
    // --force-recreate so it always builds the tree as it is right now
    const started = await compose('up', '-d', '--force-recreate', CONTAINER);
    if (started !== 0) throw new Error(`could not start ${CONTAINER}`);

    let stopped = false;
    const stopOnce = async (): Promise<void> => {
        if (stopped) return;
        stopped = true;
        await stopContainer();
    };
    // An interrupted run must not leave the bot talking in the group
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => {
            void stopOnce().then(() => process.exit(130));
        });
    }

    try {
        await waitUntilReady();
        console.log(`✓ ${CONTAINER} is up\n`);
        const suiteArgs = process.argv.slice(2);
        const code = await run('npx', ['tsx', 'scripts/e2e/run.mts', ...suiteArgs]);
        await stopOnce();
        process.exit(code);
    } catch (error) {
        await stopOnce();
        throw error;
    }
};

await main();
