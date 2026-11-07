/**
 * The last hourly cleanup (clearExpiredData), kept in memory for the panel's
 * process status. Null until the first pass of this process: the cleanup
 * does not run at startup.
 */
export interface CleanupRun {
    readonly finishedAt: Date;
    readonly elapsedMs: number;
    /** The same summary line the cleanup logs */
    readonly summary: string;
}

let lastCleanupRun: CleanupRun | null = null;

export const recordCleanupRun = (summary: string, elapsedMs: number): void => {
    lastCleanupRun = { finishedAt: new Date(), elapsedMs, summary };
};

export const getLastCleanupRun = (): CleanupRun | null => lastCleanupRun;
