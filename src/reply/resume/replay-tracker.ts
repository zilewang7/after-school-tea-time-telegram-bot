/**
 * How long a resume's replay took (design 2026-1112-1123 §6.6): one log line
 * once the replayed chunks are over. Only the log keeps it; it is there to
 * tell how slow the legacy split mode replays in practice.
 */

export interface ReplayTracker {
    /** A replayed chunk was processed */
    readonly note: () => void;
    /** The replay is over (a new chunk came, or the stream ended); logs once, only after a replay */
    readonly end: () => void;
}

export const createReplayTracker = (now: () => number = Date.now): ReplayTracker => {
    let chunks = 0;
    let startedAt: number | null = null;
    let logged = false;
    return {
        note: () => {
            startedAt ??= now();
            chunks += 1;
        },
        end: () => {
            if (startedAt === null || logged) return;
            logged = true;
            console.log(`[resume] replay chunks=${chunks} ms=${now() - startedAt}`);
        },
    };
};
