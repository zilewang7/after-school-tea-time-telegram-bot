/**
 * Whether `docker stop` (and so a restart or a recreate) reaches the bot.
 *
 * It does when pm2 is the process the container's init passes signals to: pm2
 * then asks the bot to shut down, and the bot closes the database, which
 * merges the write-ahead log into the file. It does not when a shell sits in
 * between or is PID 1 itself: the signal is dropped, docker kills everything
 * after the grace period, and the log stays where it is, in the container's
 * own layer. A restart keeps that layer; a recreate (`up -d`) deletes it.
 */
import { spawnSync } from 'node:child_process';
import { PRODUCTION_CONTAINER } from '../lib/production.mts';

interface ContainerProcess {
    pid: number;
    parentPid: number;
    command: string;
}

const readContainerProcesses = (): ContainerProcess[] => {
    const listed = spawnSync('docker', ['exec', PRODUCTION_CONTAINER, 'ps', '-o', 'pid,ppid,args'], { encoding: 'utf8' });
    if (listed.status !== 0) return [];
    return listed.stdout
        .split('\n')
        .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
        .flatMap((match) => (match === null ? [] : [{ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] ?? '' }]));
};

const isInit = (command: string): boolean => /(^|\/)(docker-init|tini)(\s|$)/.test(command);

/** undefined when a stop reaches the bot; otherwise what stands in the way */
export const stopSignalProblem = (processes: ContainerProcess[] = readContainerProcesses()): string | undefined => {
    const first = processes.find((process) => process.pid === 1);
    const manager = processes.find((process) => process.command.includes('pm2-runtime'));
    if (first === undefined || manager === undefined) return 'the process list of the container could not be read';
    if (manager.pid === 1) return undefined;
    if (manager.parentPid === 1 && isInit(first.command)) return undefined;
    return `PID 1 is \`${first.command}\`, which does not pass the signal on to pm2`;
};
