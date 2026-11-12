import { TabCount } from '../../components/tab-count';
import { useMe } from '../../context/me-context';

/** Pending access applications, from /api/me (owner only; null for everyone else) */
export const HomePendingAccessBadge = () => {
    const { me } = useMe();
    return <TabCount count={me.pendingAccessApplications ?? 0} />;
};
