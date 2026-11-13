/** Fixture: passes, and says which process ran it */
import { expect, reportResults, runCase } from '../../harness.mts';
import { noteProcess } from './support.mts';

const results = [
    await runCase('passes', () => {
        noteProcess('passes');
        expect(true, 'nothing to check');
    }),
];

reportResults(results);
