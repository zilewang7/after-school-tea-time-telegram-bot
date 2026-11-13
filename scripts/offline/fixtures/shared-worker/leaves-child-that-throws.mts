/** Fixture: passes, and leaves a child process running whose end it answers with an error */
import { spawn } from 'node:child_process';
import { expect, reportResults, runCase } from '../../harness.mts';

const results = [
    await runCase('leaves a child process running', () => {
        const child = spawn('sleep', ['60'], { stdio: 'ignore' });
        child.unref();
        // Never runs in a process of its own: that one is gone before the child is
        child.on('exit', () => {
            throw new Error('thrown when the child process ended');
        });
        expect(child.pid !== undefined, 'the child process started');
    }),
];

reportResults(results);
