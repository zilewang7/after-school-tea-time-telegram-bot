/**
 * The `mediaHint` vocabulary, and the few rules that read it.
 *
 * A hint is written once by autoSave from the captured media (`a video`,
 * `a video note`, `a picture`, …) and may carry a suffix: a failure reason
 * (`a video — too large to process, you cannot see it`) or the backfilled
 * wording (`a video — recovered from history, …`). Anything that needs
 * "is this a video?" must therefore test the prefix, never the whole string.
 */

/** A video message and a round video note; a GIF is an animation, not a video */
const VIDEO_HINT_PATTERN = /^a video(?: note)?(?:$|[\s,])/;

export const isVideoMediaHint = (hint: string | null | undefined): boolean =>
    typeof hint === 'string' && VIDEO_HINT_PATTERN.test(hint);
