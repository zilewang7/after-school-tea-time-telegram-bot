/** Fixture: passes once the test has written `note-one`, and says which process ran it */
import { expect, reportResults, runCase } from '../../harness.mts';
import { noteProcess, waitForNote } from './support.mts';

const results = [
    await runCase('goes on when the test says so', async () => {
        noteProcess('waits-for-note-one');
        await waitForNote('note-one');
        expect(true, 'the note came');
    }),
];

reportResults(results);
