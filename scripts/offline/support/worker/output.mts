/**
 * Sends what a test file writes to stdout and stderr into that file's log.
 *
 * The writes are synchronous and go to one descriptor, so the log holds the
 * lines in the order they were written, as it does when a test process has the
 * log as its stdout and stderr.
 */
import { writeSync } from 'node:fs';

type WriteCallback = (error?: Error | null) => void;

let logDescriptor: number | undefined;

const routeStream = (stream: NodeJS.WriteStream): void => {
    const writeToStream = stream.write.bind(stream);
    stream.write = (
        chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | WriteCallback,
        callback?: WriteCallback
    ): boolean => {
        if (logDescriptor === undefined) {
            return typeof encodingOrCallback === 'function'
                ? writeToStream(chunk, encodingOrCallback)
                : writeToStream(chunk, encodingOrCallback, callback);
        }
        if (typeof chunk === 'string') {
            writeSync(logDescriptor, chunk, null, typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8');
        } else {
            writeSync(logDescriptor, chunk);
        }
        const written = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
        if (written !== undefined) process.nextTick(written);
        return true;
    };
};

/** Once per worker, before anything is written */
export const routeOutput = (): void => {
    routeStream(process.stdout);
    routeStream(process.stderr);
};

/** `undefined` sends output to the worker's own stdout and stderr again */
export const sendOutputTo = (descriptor: number | undefined): void => {
    logDescriptor = descriptor;
};

/** For text that is not written through a stream: the worker's own notes in a file's log */
export const writeToLog = (text: string): void => {
    if (logDescriptor !== undefined) writeSync(logDescriptor, text);
    else process.stderr.write(text);
};
