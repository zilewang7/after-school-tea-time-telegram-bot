/**
 * The environment variables and the working directory every test file of a
 * worker starts from: the ones the worker itself was started with.
 */

let startEnvironment: Readonly<Record<string, string | undefined>> = {};
let startDirectory = '';

/** Once per worker, before the first file */
export const recordEnvironment = (): void => {
    startEnvironment = { ...process.env };
    startDirectory = process.cwd();
};

export const restoreEnvironment = (): void => {
    for (const key of Object.keys(process.env)) {
        if (!(key in startEnvironment)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(startEnvironment)) {
        if (process.env[key] !== value) process.env[key] = value;
    }
    if (process.cwd() !== startDirectory) process.chdir(startDirectory);
};
