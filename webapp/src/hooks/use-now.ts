import { useEffect, useState } from 'react';

/** Re-renders every `intervalMs` with the current time, for live elapsed counters */
export const useNow = (intervalMs: number): number => {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
        return () => window.clearInterval(timer);
    }, [intervalMs]);
    return now;
};
