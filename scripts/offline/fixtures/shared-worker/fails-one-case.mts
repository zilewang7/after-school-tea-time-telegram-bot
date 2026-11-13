/** Fixture: one case passes, one fails; says which process ran it */
import { expect, reportResults, runCase } from '../../harness.mts';
import { noteProcess } from './support.mts';

const results = [
    await runCase('a case that passes', () => {
        noteProcess('fails-one-case');
        expect(1 + 1 === 2, 'arithmetic works');
    }),
    await runCase('a case that fails', () => {
        expect(1 + 1 === 3, 'arithmetic is broken');
    }),
];

reportResults(results);
