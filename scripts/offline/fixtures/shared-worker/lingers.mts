/** Fixture: every case passes, but a server is left listening */
import { createServer } from 'node:http';
import { expect, reportResults, runCase } from '../../harness.mts';

const results = [
    await runCase('starts a server and never closes it', async () => {
        const server = createServer();
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        expect(server.listening, 'the server listens');
    }),
];

reportResults(results);
