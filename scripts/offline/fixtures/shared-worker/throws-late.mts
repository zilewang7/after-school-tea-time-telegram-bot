/** Fixture: every case passes, then something a case left behind throws */
import { expect, reportResults, runCase } from '../../harness.mts';

const results = [
    await runCase('leaves a timer that throws', () => {
        setTimeout(() => {
            throw new Error('thrown after the summary');
        }, 30);
        expect(true, 'the timer is set');
    }),
];

reportResults(results);
