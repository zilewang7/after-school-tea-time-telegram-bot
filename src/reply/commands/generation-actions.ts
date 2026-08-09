/**
 * The "do it again" closures the 🔄 重试 and ✍️ 重写分镜 buttons press.
 *
 * A store separate from the job one because neither button can be keyed by a
 * job id: 重试 exists precisely for the failures that happen BEFORE a job id
 * comes back (health, submit), and 重写 hangs on the storyboard message, which
 * is posted before the job is submitted. So the caller mints an id here and
 * hands the button that instead.
 *
 * Closures rather than serialized commands: this file then knows nothing about
 * any one command's shape, and a rewrite re-reads its reference images from the
 * DB instead of every tracked idea holding base64 in memory.
 */

/** Bounded like the job store; these are one-tap follow-ups, not history */
const MAX_TRACKED_ACTIONS = 200;

export type GenerationActionFn = () => Promise<void>;

const actions = new Map<string, GenerationActionFn>();

let counter = 0;

/**
 * Ids only have to be unique within one process lifetime and unguessable
 * enough that a stray callback doesn't collide; a counter plus randomness is
 * plenty, and it keeps the callback data short (Telegram caps it at 64 bytes).
 */
export const rememberAction = (action: GenerationActionFn): string => {
    counter += 1;
    const id = `${counter.toString(36)}-${Math.floor(Math.random() * 36 ** 4).toString(36)}`;
    actions.set(id, action);
    while (actions.size > MAX_TRACKED_ACTIONS) {
        const oldest = actions.keys().next();
        if (oldest.done) break;
        actions.delete(oldest.value);
    }
    return id;
};

export const recallAction = (id: string): GenerationActionFn | undefined => actions.get(id);

/** Test seam: the store is process-wide state */
export const forgetAllActions = (): void => {
    actions.clear();
    counter = 0;
};
