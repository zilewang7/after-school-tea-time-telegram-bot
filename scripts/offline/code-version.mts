/**
 * Offline cases for the version /api/health reports.
 *
 * The deploy script records the commit a build came from in dist/BUILD_COMMIT.
 * That record has to win over git: after a failed build the checkout is
 * already at the new commit while the old build keeps running, and a version
 * read from git would make a failed deploy look like a successful one.
 *
 * Run: pnpm test:offline code-version
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';

const { readCodeVersion } = await import('../../src/panel/version.js');

const scratchDirectory = mkdtempSync(join(tmpdir(), 'k-on-bot-code-version-'));
const recordOf = (name: string, content: string): string => {
    const path = join(scratchDirectory, name);
    writeFileSync(path, content);
    return path;
};

const results: CaseResult[] = [];

results.push(
    await runCase('a recorded build commit is reported, not the checkout', async () => {
        const version = await readCodeVersion(recordOf('recorded', 'abc1234\n'));
        expect(version === 'abc1234', `the recorded commit wins (got ${String(version)})`);
    })
);

results.push(
    await runCase('without a record the checkout is asked', async () => {
        const fromGit = await readCodeVersion(join(scratchDirectory, 'missing'));
        expect(fromGit !== null && /^[0-9a-f]{4,40}$/.test(fromGit), `git answered (got ${String(fromGit)})`);
    })
);

results.push(
    await runCase('a record that is not a commit hash is ignored', async () => {
        const fromGit = await readCodeVersion(join(scratchDirectory, 'missing'));
        for (const content of ['', 'unknown\n', 'abc1234; rm -rf /\n']) {
            const version = await readCodeVersion(recordOf('garbage', content));
            expect(version === fromGit, `${JSON.stringify(content)} falls back to git`);
        }
    })
);

rmSync(scratchDirectory, { recursive: true, force: true });
reportResults(results);
