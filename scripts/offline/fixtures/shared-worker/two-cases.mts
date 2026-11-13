/** Fixture: two cases, for the case filter */
import { expect, reportResults, runCase } from '../../harness.mts';

const results = [
    await runCase('first case', () => {
        expect(true, 'runs unless filtered out');
    }),
    await runCase('second case', () => {
        expect(true, 'runs unless filtered out');
    }),
];

reportResults(results);
