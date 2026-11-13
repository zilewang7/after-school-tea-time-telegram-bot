/**
 * What every test file of a worker starts from, as far as it is not a property
 * of an object (globals.mts): the environment variables, the working
 * directory, the file mode mask and the command line the worker itself was
 * started with.
 */
import { resolve } from 'node:path';

let startEnvironment: Readonly<Record<string, string | undefined>> = {};
let startDirectory = '';
let startMask = 0;
let startArguments: readonly string[] = [];

/** Once per worker, before the first file */
export const recordEnvironment = (): void => {
    startEnvironment = { ...process.env };
    startDirectory = process.cwd();
    // Setting it is the way to read it that Node does not discourage
    startMask = process.umask(0);
    process.umask(startMask);
    startArguments = [...process.argv];
};

export const restoreEnvironment = (): void => {
    for (const key of Object.keys(process.env)) {
        if (!(key in startEnvironment)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(startEnvironment)) {
        if (process.env[key] !== value) process.env[key] = value;
    }
    if (process.cwd() !== startDirectory) process.chdir(startDirectory);
    process.umask(startMask);
    process.argv.splice(0, Infinity, ...startArguments);
};

/** The command line of a process started for the file: `node <its path>` */
export const setArgumentsOf = (file: string): void => {
    process.argv.splice(0, Infinity, process.execPath, resolve(file));
};
