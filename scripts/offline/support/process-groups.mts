/**
 * The process groups of the tests that are running: every test process and
 * every shared worker leads a group of its own, so it can be ended together
 * with anything it started.
 */
import { removeScratchDirectoryOf } from './scratch-directory.mts';

/** Every group still running, so an interrupted run can take them down */
const liveProcessGroups = new Set<number>();

export const trackProcessGroup = (groupId: number): void => {
    liveProcessGroups.add(groupId);
};

/**
 * Ends a test process and anything it started, and removes the scratch
 * directory it could not remove itself. Harmless when it has already ended.
 */
export const endProcessGroup = (groupId: number): void => {
    liveProcessGroups.delete(groupId);
    try {
        // A negative pid addresses the whole group: the process and anything it spawned
        process.kill(-groupId, 'SIGKILL');
    } catch {
        // Nothing left in the group
    }
    // The group id is the pid of the test process, which names its scratch directory
    removeScratchDirectoryOf(groupId);
};

export const killLiveTestProcesses = (): void => {
    for (const groupId of liveProcessGroups) endProcessGroup(groupId);
};
