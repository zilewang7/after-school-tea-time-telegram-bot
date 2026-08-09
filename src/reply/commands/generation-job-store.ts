/**
 * The in-memory record of recent generation jobs (pictures and videos alike).
 *
 * It exists for two buttons: ⏹ 取消 needs to tell a running poll loop to stop,
 * and 🎲 重掷 needs the request body that produced the result. Both are
 * short-lived interactions, so a bounded Map is enough — a restart makes the
 * buttons answer "任务已过期", which beats a table that has to be cleaned up.
 *
 * ✍️ 重写 is keyed separately (see replan-store): it hangs on a message posted
 * before the job exists, so it cannot be keyed by job id.
 */
import type {
    GenerationMediaKind,
    GenerationRequest,
} from '../../services/comfy-forward-service.js';

/** Older entries are evicted; nobody presses 重掷 on the 201st-oldest result */
const MAX_TRACKED_JOBS = 200;

export interface TrackedJob {
    kind: GenerationMediaKind;
    chatId: number;
    /** The user message the result replies to */
    userMessageId: number;
    request: GenerationRequest;
    spoiler: boolean;
    workflowName: string;
    cancelled: boolean;
}

const jobs = new Map<string, TrackedJob>();

export const rememberJob = (jobId: string, job: TrackedJob): void => {
    jobs.set(jobId, job);
    while (jobs.size > MAX_TRACKED_JOBS) {
        const oldest = jobs.keys().next();
        if (oldest.done) break;
        jobs.delete(oldest.value);
    }
};

export const recallJob = (jobId: string): TrackedJob | undefined => jobs.get(jobId);

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
