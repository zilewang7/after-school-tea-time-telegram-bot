/**
 * Not a test file: a runner of its own. shared-worker.mts starts it and kills
 * it, to see what becomes of the worker it leaves behind.
 *
 *   node --import tsx suite-process.mts <directory for logs and notes> <test file>…
 */
import { fileURLToPath } from 'node:url';
import { runSuite } from '../../support/run-suite.mts';

const [directory, ...files] = process.argv.slice(2);
if (directory === undefined) throw new Error('usage: suite-process.mts <directory> <test file>…');

await runSuite(files, {
    repositoryRoot: fileURLToPath(new URL('../../../../', import.meta.url)),
    logDirectory: directory,
    jobs: 1,
    timeoutMs: 60_000,
    caseFilter: undefined,
    bail: false,
    shared: true,
    extraEnvironment: { SHARED_WORKER_FIXTURE_DIRECTORY: directory },
    onReport: () => undefined,
});
