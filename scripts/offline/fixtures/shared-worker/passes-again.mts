/** Fixture: passes; a second file for runs that need two */
import { expect, reportResults, runCase } from '../../harness.mts';
import { noteProcess } from './support.mts';

const results = [
    await runCase('passes again', () => {
        noteProcess('passes-again');
        expect(true, 'nothing to check');
    }),
];

reportResults(results);
