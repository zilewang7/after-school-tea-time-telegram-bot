/**
 * Shared by the fixture test files of scripts/offline/shared-worker.mts. These
 * files are not tests of their own: that test runs them, in shared workers and
 * in processes of their own, and looks at what they leave in the scratch
 * directory it names in SHARED_WORKER_FIXTURE_DIRECTORY.
 */
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * How long after it was started the work leaves-traces.mts leaves behind would
 * show. Long enough for the next file to be running by then, also on a busy
 * machine: only then can it tell whether the work was stopped.
 */
export const LEFTOVER_DELAY_MS = 3000;

/** One array per evaluation of this module: a file that finds it empty has its own copy */
export const moduleVisits: string[] = [];

export const scratchPath = (name: string): string =>
    join(process.env.SHARED_WORKER_FIXTURE_DIRECTORY ?? '', name);

export const appendToScratch = (name: string, text: string): void => appendFileSync(scratchPath(name), text);

export const scratchSizeOf = (name: string): number =>
    statSync(scratchPath(name), { throwIfNoEntry: false })?.size ?? 0;

/** Lets the test see which process ran the fixture */
export const noteProcess = (fixtureName: string): void => appendToScratch(`pid-${fixtureName}`, `${process.pid}\n`);

/** Resolves once the test has written the note of that name: it decides when the fixture goes on */
export const waitForNote = async (name: string, withinMs = 25_000): Promise<void> => {
    const deadline = Date.now() + withinMs;
    while (statSync(scratchPath(name), { throwIfNoEntry: false }) === undefined) {
        if (Date.now() > deadline) throw new Error(`the note ${name} was never written`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
};

/** What the stand-in for a package offers */
export interface FixturePackage {
    /** Appends to the note every 20 ms, on a timer that does not keep the process running */
    startTicker: (notePath: string) => void;
    /** Starts a process that does not keep this one running, and returns its id */
    startHelper: () => number | undefined;
}

const FIXTURE_PACKAGE_SOURCE = `
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

export const startTicker = (notePath) => {
    setInterval(() => appendFileSync(notePath, 'x'), 20).unref();
};

export const startHelper = () => {
    const helper = spawn('sleep', ['60'], { stdio: 'ignore' });
    helper.unref();
    return helper.pid;
};
`;

/**
 * A module under a `node_modules` directory, written into the scratch
 * directory. That path makes it a package to a worker: loaded once, and left
 * to go on using what it started when the file that imported it has ended.
 */
export const importFixturePackage = async (): Promise<FixturePackage> => {
    const directory = scratchPath(join('node_modules', 'fixture-package'));
    mkdirSync(directory, { recursive: true });
    const entry = join(directory, 'index.mjs');
    writeFileSync(entry, FIXTURE_PACKAGE_SOURCE);
    const fixturePackage: FixturePackage = await import(pathToFileURL(entry).href);
    return fixturePackage;
};
