/**
 * A shared worker process as the runner holds it: started, listened to, and
 * ended together with whatever it started.
 */
import { fileURLToPath } from 'node:url';
import { endProcessGroup } from './process-groups.mts';
import { spawnTestProcess } from './test-process.mts';
import { isWorkerMessage, type RunFileMessage, type WorkerMessage } from './worker/protocol.mts';

const WORKER_ENTRY = fileURLToPath(new URL('./worker/entry.mts', import.meta.url));

export interface WorkerEvents {
    onMessage: (message: WorkerMessage) => void;
    /** null: the worker was killed, or could not be started or reached */
    onExit: (exitCode: number | null) => void;
}

const NO_EVENTS: WorkerEvents = { onMessage: () => undefined, onExit: () => undefined };

export interface WorkerConnectionOptions {
    repositoryRoot: string;
    /** Receives what the worker writes outside of a test file */
    logPath: string;
    environment: NodeJS.ProcessEnv;
}

export interface WorkerConnection {
    hasExited(): boolean;
    /** Whoever waits for the worker's next answer; one at a time. `undefined`: nobody. */
    listen(events: WorkerEvents | undefined): void;
    send(message: RunFileMessage): void;
    /** Lets the worker end on its own: it does when the channel closes. false: there is no channel to close. */
    disconnect(): boolean;
    /** Ends the worker and anything it started, at once. Its exit follows as an event. */
    end(): void;
}

export const connectWorker = (options: WorkerConnectionOptions): WorkerConnection => {
    const child = spawnTestProcess(WORKER_ENTRY, { ...options, logFlags: 'a', channel: true });
    const groupId = child.pid;
    let exited = false;
    let events = NO_EVENTS;

    const end = (): void => {
        if (groupId !== undefined) endProcessGroup(groupId);
    };
    const noteExit = (exitCode: number | null): void => {
        if (exited) return;
        exited = true;
        // Whatever the worker left running or on disk goes with it
        end();
        events.onExit(exitCode);
    };
    child.on('message', (message: unknown) => {
        if (isWorkerMessage(message)) events.onMessage(message);
    });
    // Also a message that could not be sent because the worker is gone; more than one may follow
    child.on('error', () => noteExit(null));
    child.once('exit', noteExit);

    return {
        hasExited: () => exited,
        listen: (next) => {
            events = next ?? NO_EVENTS;
        },
        send: (message) => void child.send(message),
        disconnect: () => {
            if (!child.connected) return false;
            child.disconnect();
            return true;
        },
        end,
    };
};
