import { useSyncExternalStore } from 'react';
import { getConnectivityBanner, subscribeConnectivity } from '../api';

/** Top bar shown while any GET is waiting to retry an unreachable bot */
export const ConnectivityBanner = () => {
    const message = useSyncExternalStore(subscribeConnectivity, getConnectivityBanner);
    if (message === null) return null;
    return (
        <div className="banner" role="status">
            {message}
        </div>
    );
};
