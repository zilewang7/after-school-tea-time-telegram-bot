/**
 * Shared by the fixture test files of scripts/offline/shared-worker.mts. These
 * files are not tests of their own: that test runs them, in shared workers and
 * in processes of their own, and looks at what they leave in the scratch
 * directory it names in SHARED_WORKER_FIXTURE_DIRECTORY.
 */
import { appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
