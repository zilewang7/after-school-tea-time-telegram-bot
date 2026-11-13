/** Fixture: passes, and is still waiting for a file operation to finish when the limit on lingering has passed */
import { execFileSync, spawn } from 'node:child_process';
import { close, open } from 'node:fs';
import { expect, reportResults, runCase } from '../../harness.mts';
import { scratchPath } from './support.mts';

/** Longer than the harness lets a file run on after its summary */
const OPENS_AFTER_SECONDS = 4;

const results = [
    await runCase('starts a file operation that takes its time', () => {
        const pipePath = scratchPath(`slow-pipe-${process.pid}`);
        execFileSync('mkfifo', [pipePath]);
        let opened = false;
        // A named pipe opens for reading when somebody opens it for writing
        open(pipePath, 'r', (error, descriptor) => {
            opened = true;
            if (error === null) close(descriptor, () => undefined);
        });
        spawn('sh', ['-c', `sleep ${OPENS_AFTER_SECONDS}; : > "$PIPE"`], {
            stdio: 'ignore',
            env: { ...process.env, PIPE: pipePath },
        }).unref();
        expect(!opened, 'the pipe is not open yet');
    }),
];

reportResults(results);
