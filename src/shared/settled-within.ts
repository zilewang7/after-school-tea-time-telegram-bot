/**
 * Waits for the work to settle, but no longer than the limit. Resolves to
 * whether it settled in time. A rejection counts as settled and is not thrown:
 * the caller only needs to know that the wait is over.
 */
export const settledWithin = async (work: Promise<unknown>, limitMs: number): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), limitMs);
    });
    try {
        return await Promise.race([
            work.then(
                () => true,
                () => true
            ),
            timedOut,
        ]);
    } finally {
        clearTimeout(timer);
    }
};
