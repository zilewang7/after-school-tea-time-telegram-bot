/**
 * Read-only checks around a release. Nothing here restarts or changes anything.
 *
 *   pnpm deploy:check          before a restart: what would ship, and is now a good moment
 *   pnpm deploy:check --wait   after a restart: wait for the new build and report how it went
 *
 * A release is `docker compose restart k-on-bot`: the container fetches
 * origin/master, builds and starts. The restart kills the running process, so
 * a reply that is being generated at that moment is cut off. The check before
 * therefore looks for replies in progress, and for a commit on origin/master
 * that has not passed `pnpm verify`. It also says whether a stop reaches the
 * bot at all, which decides whether the container may be recreated.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCTION_CONTAINER, queryProduction, readLiveHealth } from '../lib/production.mts';
import { ageSecondsOf } from './reply-age.mts';
import { stopSignalProblem } from './stop-signal.mts';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RELEASE_BRANCH = 'master';
/**
 * A streaming reply moves its row's updatedAt forward every minute or so (the
 * heartbeat; the longest gap is a silent stretch of the model, at most 15
 * minutes), so a processing row untouched for longer is a leftover
 */
const REPLY_MAX_AGE_MS = 25 * 60 * 1000;
const WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;

interface CommandOutcome {
    ok: boolean;
    output: string;
}

const run = (command: string, args: string[]): CommandOutcome => {
    const outcome = spawnSync(command, args, { cwd: REPOSITORY_ROOT, encoding: 'utf8' });
    return { ok: outcome.status === 0, output: `${outcome.stdout ?? ''}`.trim() };
};

const short = (commit: string): string => commit.slice(0, 7);

/** The commit a restart would fetch: asked from the remote, not from the local ref */
const readTargetCommit = (): string | null => {
    const remote = run('git', ['ls-remote', 'origin', `refs/heads/${RELEASE_BRANCH}`]);
    const commit = remote.output.split(/\s+/)[0] ?? '';
    return remote.ok && /^[0-9a-f]{40}$/.test(commit) ? commit : null;
};

const isKnownLocally = (commit: string): boolean => run('git', ['cat-file', '-e', `${commit}^{commit}`]).ok;

const passedVerify = (commit: string): boolean => {
    const tree = run('git', ['rev-parse', `${commit}^{tree}`]);
    const record = resolve(REPOSITORY_ROOT, run('git', ['rev-parse', '--git-common-dir']).output, 'k-on-bot-verified-trees');
    if (!tree.ok || !existsSync(record)) return false;
    return readFileSync(record, 'utf8')
        .split('\n')
        .some((line) => line.startsWith(`${tree.output} `));
};

const countCommits = (range: string): number | null => {
    const counted = run('git', ['rev-list', '--count', range]);
    return counted.ok ? Number(counted.output) : null;
};

interface ReplyInProgress {
    chatId: unknown;
    messageId: unknown;
    ageSeconds: number;
}

const readRepliesInProgress = (): ReplyInProgress[] =>
    queryProduction(
        "SELECT chatId, messageId, updatedAt FROM bot_responses WHERE buttonState = 'processing' ORDER BY updatedAt DESC"
    ).map((row) => ({ chatId: row.chatId, messageId: row.messageId, ageSeconds: ageSecondsOf(row.updatedAt) }));

/** Prints the state before a restart; returns the reasons not to restart now */
const checkBefore = (target: string): string[] => {
    const reasons: string[] = [];
    const live = readLiveHealth();
    console.log(`live     ${live?.version ?? 'not answering'}${live?.startedAt ? `  (started ${live.startedAt})` : ''}`);
    console.log(`target   ${short(target)}  origin/${RELEASE_BRANCH}`);

    if (live?.version && target.startsWith(live.version)) {
        console.log('         production already runs this commit; a restart ships nothing new');
    } else if (live?.version && isKnownLocally(target)) {
        const pending = countCommits(`${live.version}..${target}`);
        if (pending !== null) console.log(`         ${pending} commits to ship`);
    }

    if (!isKnownLocally(target)) {
        reasons.push(`origin/${RELEASE_BRANCH} is at a commit this checkout does not have; fetch and verify it first`);
    } else if (!passedVerify(target)) {
        reasons.push(`${short(target)} has not passed \`pnpm verify\``);
    }
    const unpushed = isKnownLocally(target) ? countCommits(`${target}..${RELEASE_BRANCH}`) : null;
    if (unpushed !== null && unpushed > 0) {
        console.log(`         note: ${unpushed} local commits on ${RELEASE_BRANCH} are not pushed and will not ship`);
    }

    const replies = readRepliesInProgress();
    const recent = replies.filter((reply) => reply.ageSeconds * 1000 < REPLY_MAX_AGE_MS);
    console.log(`replies in progress: ${recent.length}${replies.length > recent.length ? ` (plus ${replies.length - recent.length} stale rows)` : ''}`);
    for (const reply of recent) {
        console.log(`         chat ${String(reply.chatId)} message ${String(reply.messageId)}, last update ${reply.ageSeconds}s ago`);
    }
    if (recent.length > 0) reasons.push('a reply is being generated; a restart would cut it off');

    // Not a reason against a restart, which keeps the container's files
    const stopProblem = stopSignalProblem();
    if (stopProblem === undefined) {
        console.log('stop     reaches the bot: it shuts down and closes the database');
    } else {
        console.log(`stop     does NOT reach the bot: ${stopProblem}`);
        console.log('         a restart is safe; a recreate (up -d) would lose what is in the write-ahead log');
    }
    return reasons;
};

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const containerStartedAt = (): string =>
    run('docker', ['inspect', '-f', '{{.State.StartedAt}}', PRODUCTION_CONTAINER]).output;

/** Waits for the new build to answer; returns what went wrong, if anything */
const waitForRelease = async (target: string): Promise<string[]> => {
    const startedAt = containerStartedAt();
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    let live = readLiveHealth();
    while (live === null && Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        live = readLiveHealth();
    }
    const deployLines = spawnSync('docker', ['logs', '--since', startedAt, PRODUCTION_CONTAINER], { encoding: 'utf8' });
    const deployLog = `${deployLines.stdout}${deployLines.stderr}`.split('\n').filter((line) => line.includes('[deploy]'));
    for (const line of deployLog) console.log(line);

    if (live === null) return ['the bot is not answering /api/health'];
    const secondsSinceStart = Math.round((Date.now() - Date.parse(startedAt)) / 1000);
    console.log(`live     ${live.version ?? 'unknown'}  (answering ${secondsSinceStart}s after the container started)`);

    const reasons: string[] = [];
    if (deployLog.some((line) => line.includes('BUILD FAILED'))) reasons.push('the build failed; the previous build is running');
    if (live.version === null || !target.startsWith(live.version)) {
        reasons.push(`production runs ${live.version ?? 'an unknown commit'}, not ${short(target)}`);
    }
    return reasons;
};

const target = readTargetCommit();
if (target === null) {
    console.error(`could not read origin/${RELEASE_BRANCH} from the remote`);
    process.exit(1);
}
const waiting = process.argv.includes('--wait');
const reasons = waiting ? await waitForRelease(target) : checkBefore(target);
if (reasons.length === 0) {
    console.log(waiting ? `\nreleased ${short(target)}` : '\nREADY: nothing stands in the way of a restart');
} else {
    console.log(`\n${waiting ? 'RELEASE PROBLEM' : 'NOT READY'}:`);
    for (const reason of reasons) console.log(`  - ${reason}`);
    process.exitCode = 1;
}
