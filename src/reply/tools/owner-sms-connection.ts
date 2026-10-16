/**
 * The owner SMS server connection: opened on the first send, cached for the
 * next one.
 *
 * A send takes the connection for itself and puts it back only when the server
 * answered over it; after a failure below the tool level it is closed instead,
 * so the next send reconnects. Sends never share a connection, so closing a
 * broken one can never cut off another send that is still waiting.
 */
import type { McpServerConnection } from '../../ai/mcp/index.js';

export interface OwnerSmsConnections {
    /** The cached connection or a new one; rejects when `signal` aborts before it is up */
    readonly take: (signal: AbortSignal) => Promise<McpServerConnection>;
    /** Back into the cache: the server answered over it */
    readonly keep: (connection: McpServerConnection) => void;
    /** Closed for good: the next send reconnects */
    readonly discard: (connection: McpServerConnection) => void;
}

const closeConnection = (connection: McpServerConnection): void => {
    connection.client.close().catch(() => undefined);
};

/**
 * `connecting`, unless `signal` aborts first. The send stops waiting then, but
 * a connection that still comes up goes to `adopt` instead of leaking.
 */
const connectUnlessAborted = (
    connecting: Promise<McpServerConnection>,
    signal: AbortSignal,
    adopt: (connection: McpServerConnection) => void
): Promise<McpServerConnection> =>
    new Promise((resolve, reject) => {
        const stopWaiting = (): void => reject(signal.reason);
        signal.addEventListener('abort', stopWaiting, { once: true });
        connecting.then(
            (connection) => {
                signal.removeEventListener('abort', stopWaiting);
                if (signal.aborted) {
                    adopt(connection);
                } else {
                    resolve(connection);
                }
            },
            (error: unknown) => {
                signal.removeEventListener('abort', stopWaiting);
                reject(error);
            }
        );
    });

export const createOwnerSmsConnections = (
    connect: () => Promise<McpServerConnection>
): OwnerSmsConnections => {
    let cached: McpServerConnection | undefined;

    const keep = (connection: McpServerConnection): void => {
        // Concurrent sends may each have opened one; caching one is enough
        if (cached === undefined) {
            cached = connection;
        } else {
            closeConnection(connection);
        }
    };

    const take = async (signal: AbortSignal): Promise<McpServerConnection> => {
        signal.throwIfAborted();
        const reused = cached;
        cached = undefined;
        return reused ?? connectUnlessAborted(connect(), signal, keep);
    };

    return { take, keep, discard: closeConnection };
};
