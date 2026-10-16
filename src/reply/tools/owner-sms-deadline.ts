/**
 * The abort signal one owner SMS send runs under: it aborts when the reply is
 * stopped or the deadline passes, and never once the send is over.
 *
 * The MCP SDK leaves its abort listener on a call's signal after the call has
 * returned, and aborting that signal later sends `notifications/cancelled` for
 * the finished send_text. So no `AbortSignal.timeout` / `AbortSignal.any` here:
 * `release` clears the deadline and unhooks the stop signal.
 */

export interface OwnerSmsSendAbort {
    readonly signal: AbortSignal;
    /** True once the deadline has aborted the send */
    readonly timedOut: () => boolean;
    /** The send is over: nothing aborts `signal` any more */
    readonly release: () => void;
}

export const startOwnerSmsSendAbort = (stop: AbortSignal, timeoutMs: number): OwnerSmsSendAbort => {
    const controller = new AbortController();
    let timedOut = false;

    const forwardStop = (): void => controller.abort(stop.reason);
    const deadline = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error(`The owner SMS send took longer than ${timeoutMs}ms`));
    }, timeoutMs);

    if (stop.aborted) {
        forwardStop();
    } else {
        stop.addEventListener('abort', forwardStop, { once: true });
    }

    return {
        signal: controller.signal,
        timedOut: () => timedOut,
        release: () => {
            clearTimeout(deadline);
            stop.removeEventListener('abort', forwardStop);
        },
    };
};
