/**
 * A local HTTP stub on a port the OS picks, so two runs of the suite never
 * fight over a fixed port.
 *
 * `src` snapshots most service URLs at import. A test file therefore starts
 * its stubs first, writes their URLs into the env, and only then imports `src`.
 * The server stays up for the whole file; each case installs the handler it
 * needs and resets it when done.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type StubHandler = (request: IncomingMessage, response: ServerResponse) => void;

export interface StubServer {
    /** `http://127.0.0.1:<port>`, no trailing slash */
    readonly url: string;
    /** Answer every request with `handler` until the next handle() or reset() */
    handle(handler: StubHandler): void;
    /** Back to answering 503, so a request no case expects is loud */
    reset(): void;
    close(): Promise<void>;
}

const unexpectedRequest: StubHandler = (request, response) => {
    console.error(`    [stub] unexpected ${request.method ?? '?'} ${request.url ?? '?'}`);
    response.writeHead(503, { 'Content-Type': 'text/plain' });
    response.end('no handler installed');
};

export const startStubServer = async (): Promise<StubServer> => {
    let current: StubHandler = unexpectedRequest;
    const server = createServer((request, response) => current(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('stub server has no port');
    const { port }: AddressInfo = address;

    return {
        url: `http://127.0.0.1:${port}`,
        handle: (handler) => {
            current = handler;
        },
        reset: () => {
            current = unexpectedRequest;
        },
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
};
