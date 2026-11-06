import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { MeResponse } from '../api';
import { LAST_ROUTE_KEY, launchRouteOf } from '../launch';
import type { LaunchState } from '../launch';
import { writeStorage } from '../storage';

/** Remembers the current route and, once /api/me is in, performs the one-time launch navigation */
export const useRouteMemory = (launch: LaunchState, me: MeResponse | null): void => {
    const location = useLocation();
    const navigate = useNavigate();
    const launchHandled = useRef(false);

    useEffect(() => {
        writeStorage(LAST_ROUTE_KEY, location.pathname);
    }, [location.pathname]);

    useEffect(() => {
        if (me === null || launchHandled.current) return;
        launchHandled.current = true;
        const target = launchRouteOf(launch, me.startTarget);
        if (target !== null && target !== location.pathname) void navigate(target);
    }, [launch, me, location.pathname, navigate]);
};
