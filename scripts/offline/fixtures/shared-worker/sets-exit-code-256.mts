/** Fixture: passes, with an exit code a process ends with as 0 (only its low eight bits count) */
import { expect, reportResults, runCase } from '../../harness.mts';

const results = [
    await runCase('sets exit code 256', () => {
        process.exitCode = 256;
        expect(process.exitCode === 256, 'the exit code is set');
    }),
];

reportResults(results);
