/** Fixture: passes, and leaves a detached child process, which outlives a process of its own as well */
import { spawn } from 'node:child_process';
import { expect, reportResults, runCase } from '../../harness.mts';
import { scratchPath } from './support.mts';

const results = [
    await runCase('leaves a detached child process', () => {
        // Long enough to be still at it when the file ends, also when that takes a while on a busy machine
        const child = spawn('sh', ['-c', 'sleep 2; echo x >> "$NOTE"'], {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, NOTE: scratchPath('detached-child') },
        });
        child.unref();
        expect(child.pid !== undefined, 'the child process started');
    }),
];

reportResults(results);
