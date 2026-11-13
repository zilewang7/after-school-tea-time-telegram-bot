/** Fixture: passes, and leaves behind what a file may leave when its process ends with it */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, reportResults, runCase } from '../../harness.mts';
import { scratchDirectoryOf } from '../../support/scratch-directory.mts';
import { appendToScratch, LEFTOVER_DELAY_MS, moduleVisits, noteProcess, scratchPath } from './support.mts';

const leaveValuesBehind = (): void => {
    process.env.SHARED_WORKER_FIXTURE_LEFTOVER = 'set by leaves-traces';
    Date.now = () => 0;
    globalThis.fetch = () => Promise.reject(new Error('replaced by leaves-traces'));
    Reflect.set(globalThis, 'sharedWorkerFixtureLeftover', true);
    // Under a name of its own: an arrow function stored as `get` would be called "get" as well
    Object.assign(http, { get: function replacedByLeavesTraces() {} });
    // Reaches `import { get } from 'node:http'` too
    syncBuiltinESMExports();
    appendToScratch('mask', `${process.umask(0o077)}`);
    process.argv.push('--left-by-leaves-traces');
    process.chdir(tmpdir());
};

/** Each of these would write its note after LEFTOVER_DELAY_MS, long after this file has ended */
const leaveWorkBehind = (): void => {
    // What the worker goes by to tell whose timer or child process one is
    Error.stackTraceLimit = 0;
    Error.prepareStackTrace = () => 'formatted by leaves-traces';
    setInterval(() => appendToScratch('ticks', 'x'), 10).unref();
    AbortSignal.timeout(LEFTOVER_DELAY_MS).addEventListener('abort', () => appendToScratch('aborts', 'x'));
    spawn('sh', ['-c', `sleep ${LEFTOVER_DELAY_MS / 1000}; echo x >> "$NOTE"`], {
        stdio: 'ignore',
        env: { ...process.env, NOTE: scratchPath('child') },
    }).unref();
    appendToScratch('leftovers-due', `${performance.timeOrigin + performance.now() + LEFTOVER_DELAY_MS}`);
    // And what it would clear the timers with
    Reflect.set(globalThis, 'clearTimeout', () => undefined);
    Reflect.set(globalThis, 'clearInterval', () => undefined);
};

const leaveListenersBehind = (): void => {
    process.once('exit', (exitCode) => appendToScratch('exit-listener', `leaves-traces:${exitCode}\n`));
    // Not `once`: nothing but the worker takes it off after it ran
    process.on('exit', () => {
        appendToScratch('exit-listener-kept', 'x');
        // The harness has removed this process's scratch directory by now
        mkdirSync(scratchDirectoryOf(process.pid), { recursive: true });
        writeFileSync(join(scratchDirectoryOf(process.pid), 'left-by-leaves-traces'), '');
        // Never runs when a process really exits
        setImmediate(() => {
            process.env.SHARED_WORKER_FIXTURE_SET_LATE = 'set after the exit listeners';
            process.exitCode = 1;
            spawn('sh', ['-c', 'sleep 1; echo x >> "$NOTE"'], {
                stdio: 'ignore',
                env: { ...process.env, NOTE: scratchPath('late-child') },
            }).unref();
        });
    });
    process.on('warning', () => appendToScratch('warning-listener', 'x'));
};

const results = [
    await runCase('leaves traces behind', () => {
        noteProcess('leaves-traces');
        moduleVisits.push('leaves-traces');
        expect(moduleVisits.length === 1, "the support module is this file's own copy");
        leaveValuesBehind();
        leaveWorkBehind();
        leaveListenersBehind();
    }),
];

reportResults(results);
