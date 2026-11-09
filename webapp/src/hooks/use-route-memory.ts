import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { MeResponse } from '../api';
import { LAST_ROUTE_KEY, launchRouteOf, takeLaunchNavigation } from '../launch';
import type { LaunchState } from '../launch';
import { writeStorage } from '../storage';

/** Remembers the current route and, once /api/me is in, performs the one-time launch navigation */
export const useRouteMemory = (launch: LaunchState, me: MeResponse | null): void => {
    const location = useLocation();
    const navigate = useNavigate();

    useEffect(() => {
        writeStorage(LAST_ROUTE_KEY, location.pathname);
    }, [location.pathname]);

    useEffect(() => {
        if (me === null) return;
        const target = launchRouteOf(launch, me.startTarget);
        if (target === null || target === location.pathname) return;
        if (!takeLaunchNavigation()) return;
        // Replace, so a page opened by start_param or lastRoute has no history and Back goes to its parent
        void navigate(target, { replace: true });
    }, [launch, me, location.pathname, navigate]);
};
