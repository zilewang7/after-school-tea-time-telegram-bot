/**
 * The messages between the runner and a shared worker. One file at a time: the
 * runner sends `run` and waits for `done`, or for the worker's exit.
 */

/** Runner → worker */
export interface RunFileMessage {
    kind: 'run';
    /** Absolute, or relative to the worker's working directory */
    file: string;
    /** Receives everything the file writes; the runner has created it */
    logPath: string;
}

/** Worker → runner, once, before the first file */
export interface ReadyMessage {
    kind: 'ready';
    /** false: the module hook does not take effect in this Node, files would share module state */
    freshModules: boolean;
}

/**
 * Worker → runner: the file it was sent is about to run. A worker that ends
 * without having said so ended over what an earlier file left, not over this one.
 */
export interface FileStartedMessage {
    kind: 'started';
}

/** Worker → runner: the file has ended and the worker is ready for the next one */
export interface FileDoneMessage {
    kind: 'done';
    /** What the file's own process would have exited with */
    exitCode: number;
    /** Resident memory of the worker, in megabytes: old module copies are never freed */
    residentMegabytes: number;
    /** false: the file left something the worker could not undo, so the next file needs another worker */
    reusable: boolean;
}

export type WorkerMessage = ReadyMessage | FileStartedMessage | FileDoneMessage;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export const isRunFileMessage = (value: unknown): value is RunFileMessage =>
    isRecord(value) && value.kind === 'run' && typeof value.file === 'string' && typeof value.logPath === 'string';

const isReadyMessage = (value: unknown): value is ReadyMessage =>
    isRecord(value) && value.kind === 'ready' && typeof value.freshModules === 'boolean';

const isFileStartedMessage = (value: unknown): value is FileStartedMessage => isRecord(value) && value.kind === 'started';

const isFileDoneMessage = (value: unknown): value is FileDoneMessage =>
    isRecord(value) &&
    value.kind === 'done' &&
    typeof value.exitCode === 'number' &&
    typeof value.residentMegabytes === 'number' &&
    typeof value.reusable === 'boolean';

export const isWorkerMessage = (value: unknown): value is WorkerMessage =>
    isReadyMessage(value) || isFileStartedMessage(value) || isFileDoneMessage(value);
