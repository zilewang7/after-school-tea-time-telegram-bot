/**
 * Verifies the committed state: type check, lint, dependency guard and the
 * whole offline suite, run on a clean export of HEAD.
 *
 *   pnpm verify           verify HEAD (skips when this tree already passed)
 *   pnpm verify --force   verify again even if it already passed
 *
 * Why an export and not the working tree: several sessions edit the same
 * checkout, so the working tree holds other people's half-done changes. What
 * gets pushed is the commit, so the commit is what gets tested.
 *
 * A pass is recorded by tree hash in the git directory. The pre-push hook
 * (.githooks/pre-push) only looks that record up, so a push stays instant.
 * For quick feedback while editing use `pnpm check` and
 * `pnpm test:offline <name>`, which run on the working tree.
 */
import { spawnSync } from 'node:child_process';
import {
    appendFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const EXPORT_PARENT = join(tmpdir(), 'k-on-bot-verify');
const RECORD_FILE_NAME = 'k-on-bot-verified-trees';

/** package.json scripts, in the order they run; the first failure stops the run */
const STEPS = ['typecheck', 'lint', 'check-deps', 'test:offline'] as const;

/** Installed packages are not part of a commit: the export borrows this checkout's */
const INSTALLED_DIRECTORIES = ['node_modules', 'webapp/node_modules', 'tools/checks/node_modules'] as const;

/** pnpm keeps a copy of the lockfile it installed from next to the packages */
const INSTALLED_LOCKFILE = join(REPOSITORY_ROOT, 'node_modules', '.pnpm', 'lock.yaml');

const git = (args: string[], cwd: string = REPOSITORY_ROOT): string => {
    const outcome = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (outcome.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${outcome.stderr.trim()}`);
    return outcome.stdout.trim();
};

const recordPath = (): string => resolve(REPOSITORY_ROOT, git(['rev-parse', '--git-common-dir']), RECORD_FILE_NAME);

const alreadyVerified = (tree: string): boolean => {
    const path = recordPath();
    if (!existsSync(path)) return false;
    return readFileSync(path, 'utf8')
        .split('\n')
        .some((line) => line.startsWith(`${tree} `));
};

/**
 * The borrowed packages must be the ones the commit locks. Otherwise a commit
 * that changes dependencies is tested against the old ones, and would get a
 * record all the same.
 */
const installedPackagesMatch = (commit: string): boolean => {
    if (!existsSync(INSTALLED_LOCKFILE)) return false;
    return readFileSync(INSTALLED_LOCKFILE, 'utf8').trim() === git(['show', `${commit}:pnpm-lock.yaml`]);
};

const createExport = (commit: string, directory: string): void => {
    mkdirSync(EXPORT_PARENT, { recursive: true });
    // Forget exports whose directory is gone but still registered
    git(['worktree', 'prune']);
    git(['worktree', 'add', '--detach', directory, commit]);
    for (const installed of INSTALLED_DIRECTORIES) {
        const source = join(REPOSITORY_ROOT, installed);
        if (!existsSync(source)) continue;
        mkdirSync(dirname(join(directory, installed)), { recursive: true });
        symlinkSync(source, join(directory, installed));
    }
};

/**
 * Removes one borrowed link. `unlink`, never a recursive remove: whatever
 * happens, the installed packages the link points at must stay.
 */
const removeLink = (path: string): void => {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink() === true) unlinkSync(path);
};

/** Best effort: a leftover export costs disk space, not correctness; the next run removes it */
const removeExport = (directory: string): void => {
    try {
        // The links first: `worktree remove` refuses a directory with untracked files
        for (const installed of INSTALLED_DIRECTORIES) removeLink(join(directory, installed));
        const removed = spawnSync('git', ['worktree', 'remove', '--force', directory], { cwd: REPOSITORY_ROOT });
        // Only without the links, so a recursive remove can never reach the installed packages
        const linksGone = INSTALLED_DIRECTORIES.every((installed) => !existsSync(join(directory, installed)));
        if (removed.status !== 0 && linksGone) rmSync(directory, { recursive: true, force: true });
    } catch (error) {
        console.error(`could not remove ${directory}: ${error instanceof Error ? error.message : String(error)}`);
    }
};

const isRunning = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM: the process exists and belongs to someone else
        return error instanceof Error && 'code' in error && error.code === 'EPERM';
    }
};

/**
 * Removes the exports of runs that were killed before their own cleanup. An
 * export is named `<commit>-<pid>`; one whose process is gone is abandoned.
 */
const removeAbandonedExports = (): void => {
    if (!existsSync(EXPORT_PARENT)) return;
    for (const name of readdirSync(EXPORT_PARENT)) {
        const pid = Number(name.slice(name.lastIndexOf('-') + 1));
        if (Number.isInteger(pid) && pid > 0 && !isRunning(pid)) removeExport(join(EXPORT_PARENT, name));
    }
};

const prePushHookEnabled = (): boolean => {
    const configured = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' });
    return configured.stdout.trim() === '.githooks';
};

/** Runs one package.json script inside the export; true when it passed */
const runStep = (step: string, directory: string): boolean => {
    console.log(`\n── ${step} ──`);
    const startedAt = performance.now();
    const outcome = spawnSync('pnpm', ['run', '--silent', step], {
        cwd: directory,
        stdio: ['ignore', 'inherit', 'inherit'],
    });
    const seconds = ((performance.now() - startedAt) / 1000).toFixed(0);
    console.log(`${outcome.status === 0 ? 'passed' : 'FAILED'}: ${step} (${seconds}s)`);
    return outcome.status === 0;
};

const main = (): number => {
    const force = process.argv.includes('--force');
    const commit = git(['rev-parse', 'HEAD']);
    // Of that commit, not of HEAD again: another session may commit in between
    const tree = git(['rev-parse', `${commit}^{tree}`]);
    const shortCommit = commit.slice(0, 7);

    if (!force && alreadyVerified(tree)) {
        console.log(`${shortCommit} already passed verification`);
        return 0;
    }
    const uncommitted = git(['status', '--porcelain']).split('\n').filter((line) => line !== '').length;
    if (uncommitted > 0) {
        console.log(`verifying commit ${shortCommit}; ${uncommitted} uncommitted changes are not part of it`);
    }

    if (!installedPackagesMatch(commit)) {
        console.log(
            `the installed packages are not the ones ${shortCommit} locks (pnpm-lock.yaml differs from the last install).\n` +
                'Run `pnpm install` in the main checkout (never in a worktree), then verify again.'
        );
        return 1;
    }

    removeAbandonedExports();
    const directory = join(EXPORT_PARENT, `${shortCommit}-${process.pid}`);
    createExport(commit, directory);
    // No signal handlers: every step blocks this process, so they could not run
    // before the end anyway. Ctrl-C reaches the step as well, which fails and
    // lets `finally` clean up; a run that is killed outright leaves its export
    // to removeAbandonedExports of the next one.
    try {
        const failedStep = STEPS.find((step) => !runStep(step, directory));
        if (failedStep !== undefined) {
            console.log(`\nverification FAILED at ${failedStep} for ${shortCommit}`);
            return 1;
        }
    } finally {
        removeExport(directory);
    }

    appendFileSync(recordPath(), `${tree} ${commit} ${new Date().toISOString()}\n`);
    console.log(`\nverified ${shortCommit}; it can be pushed`);
    if (!prePushHookEnabled()) {
        console.log('note: the pre-push hook is off in this clone; turn it on once with `git config core.hooksPath .githooks`');
    }
    return 0;
};

process.exitCode = main();
