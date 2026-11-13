/** Fixture: passes, having written hex digits of an odd number, which a stream forgives */
import { expect, reportResults, runCase } from '../../harness.mts';

const results = [
    await runCase('writes an odd number of hex digits', () => {
        expect(process.stdout.write('6f646420686578200', 'hex'), 'the stream took them');
    }),
];

reportResults(results);
