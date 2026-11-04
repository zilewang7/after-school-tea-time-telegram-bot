/**
 * Per-reply budget for recording harness issues.
 *
 * The list is meant to stay a signal: a reply that files twenty near-identical
 * complaints is noise, and the model is supposed to merge what it can. Three
 * is enough for a single reply to name the friction it actually hit.
 */
export const MAX_HARNESS_ISSUES_PER_REPLY = 3;

export interface HarnessIssueState {
    readonly createdCount: () => number;
    /** True while this reply may still record another issue */
    readonly canCreate: () => boolean;
    readonly noteCreated: () => void;
}

export const createHarnessIssueState = (): HarnessIssueState => {
    let created = 0;
    return {
        createdCount: () => created,
        canCreate: () => created < MAX_HARNESS_ISSUES_PER_REPLY,
        noteCreated: () => {
            created += 1;
        },
    };
};
