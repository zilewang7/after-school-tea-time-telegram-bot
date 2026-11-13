/** Fixture: passes, and makes undici start the one timer that drives all its timeouts */
import { Agent, request } from 'undici';
import { expect, reportResults, runCase } from '../../harness.mts';
import { startStubServer } from '../../support/stub-server.mts';
import { noteProcess } from './support.mts';

const results = [
    await runCase('one request through undici', async () => {
        noteProcess('uses-package-timer');
        const stub = await startStubServer();
        stub.handle((_request, response) => response.end('ok'));
        const agent = new Agent();
        const response = await request(stub.url, { dispatcher: agent });
        expect((await response.body.text()) === 'ok', 'the stub answered');
        await agent.close();
        await stub.close();
    }),
];

reportResults(results);
