/**
 * The in-memory record of recent generation jobs.
 *
 * It exists for two buttons: ⏹ 取消 needs to tell a running poll loop to stop,
 * and 🎲 重掷 needs the request body that produced the picture. Both are
 * short-lived interactions, so a bounded Map is enough — a restart makes the
 * buttons answer "任务已过期", which beats a table that has to be cleaned up.
 */
import type { GenerationRequest } from '../../services/comfy-forward-service.js';

/** Older entries are evicted; nobody presses 重掷 on the 201st-oldest picture */
const MAX_TRACKED_JOBS = 200;

export interface PicJob {
    chatId: number;
    /** The user message the result replies to */
    userMessageId: number;
    request: GenerationRequest;
    spoiler: boolean;
    cancelled: boolean;
}

const jobs = new Map<string, PicJob>();

export const rememberJob = (jobId: string, job: PicJob): void => {
    jobs.set(jobId, job);
    while (jobs.size > MAX_TRACKED_JOBS) {
        const oldest = jobs.keys().next();
        if (oldest.done) break;
        jobs.delete(oldest.value);
    }
};

export const recallJob = (jobId: string): PicJob | undefined => jobs.get(jobId);

/** Ask the poll loop watching this job to stop. Returns false if it's unknown. */
export const cancelJob = (jobId: string): boolean => {
    const job = jobs.get(jobId);
    if (!job) return false;
    job.cancelled = true;
    return true;
};

/** Test seam: the store is process-wide state */
export const forgetAllJobs = (): void => {
    jobs.clear();
};
