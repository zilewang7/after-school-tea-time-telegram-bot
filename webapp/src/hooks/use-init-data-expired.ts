import { useEffect, useMemo, useState } from 'react';
import { serverNowMs } from '../api';
import { useWebApp } from '../context/panel-context';
import { readAuthDate } from '../telegram';

// Writes need auth_date within 5 minutes; warn 30s early so a save in flight still passes
const WRITE_WINDOW_SECONDS = 270;
const CHECK_INTERVAL_MS = 1000;

export const EXPIRED_WRITE_NOTICE = '已打开超过 5 分钟，保存前需要重新打开面板';

const isPast = (deadlineMs: number | null): boolean => deadlineMs !== null && serverNowMs() >= deadlineMs;

/**
 * True once initData is too old for write requests (initData itself never
 * refreshes while the panel stays open). Measured on the server's clock, so it
 * is re-checked every tick: the first API response can move it either way.
 */
export const useInitDataExpired = (): boolean => {
    const webApp = useWebApp();
    const deadlineMs = useMemo(() => {
        const authDate = readAuthDate(webApp);
        return authDate === null ? null : (authDate + WRITE_WINDOW_SECONDS) * 1000;
    }, [webApp]);

    const [expired, setExpired] = useState(() => isPast(deadlineMs));

    useEffect(() => {
        if (deadlineMs === null) return;
        // Polling instead of one long timeout: timers stall while the WebView is in the background
        const timer = window.setInterval(() => setExpired(isPast(deadlineMs)), CHECK_INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, [deadlineMs]);

    return expired;
};
