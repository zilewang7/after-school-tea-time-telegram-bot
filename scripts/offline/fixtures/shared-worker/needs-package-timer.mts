/**
 * Fixture: passes while undici's timeouts work, which they must also do in a
 * worker that ran uses-package-timer.mts before
 */
import { Agent, request } from 'undici';
import { expect, reportResults, runCase } from '../../harness.mts';
import { startStubServer } from '../../support/stub-server.mts';

/** Above one second undici counts the time with its shared timer */
const HEADERS_TIMEOUT_MS = 1500;
const PATIENCE_MS = 6000;

const results = [
    await runCase('undici gives up on a server that never answers', async () => {
        const stub = await startStubServer();
        stub.handle(() => undefined);
        const agent = new Agent({ headersTimeout: HEADERS_TIMEOUT_MS });
        let patience: NodeJS.Timeout | undefined;
        const outcome = await Promise.race([
            request(stub.url, { dispatcher: agent }).then(
                () => 'answered',
                (error: unknown) => (error instanceof Error ? error.name : 'not an error')
            ),
            new Promise<string>((resolve) => {
                patience = setTimeout(() => resolve('still waiting'), PATIENCE_MS);
            }),
        ]);
        clearTimeout(patience);
        expect(outcome === 'HeadersTimeoutError', `the headers timeout fired (${outcome})`);
        await agent.destroy();
        await stub.close();
    }),
];

reportResults(results);
