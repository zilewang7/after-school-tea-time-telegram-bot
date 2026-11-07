import { useEffect } from 'react';

export const STATUS_POLL_MS = 5000;

/** Runs `refresh` every `intervalMs` while `enabled`; stops on unmount or when disabled */
export const usePolling = (refresh: () => void, enabled: boolean, intervalMs = STATUS_POLL_MS): void => {
    useEffect(() => {
        if (!enabled) return;
        const timer = window.setInterval(refresh, intervalMs);
        return () => window.clearInterval(timer);
    }, [refresh, enabled, intervalMs]);
};
