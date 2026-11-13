/** Fixture: one case passes, one fails */
import { expect, reportResults, runCase } from '../../harness.mts';

const results = [
    await runCase('a case that passes', () => {
        expect(1 + 1 === 2, 'arithmetic works');
    }),
    await runCase('a case that fails', () => {
        expect(1 + 1 === 3, 'arithmetic is broken');
    }),
];

reportResults(results);
