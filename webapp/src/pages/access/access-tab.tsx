import { match } from 'ts-pattern';
import { useMe } from '../../context/me-context';
import { AccessOwnerTab } from './owner/access-owner-tab';
import { TrialAccessTab } from './trial/trial-access-tab';

/** /access: the owner's review list, a trial user's application, or a notice for full users */
export const AccessTab = () => {
    const { me } = useMe();
    return match(me)
        .with({ isOwner: true }, () => <AccessOwnerTab />)
        .with({ accessTier: 'trial' }, () => <TrialAccessTab />)
        .otherwise(() => (
            <div className="placeholder">
                <p>你已拥有完整权限</p>
            </div>
        ));
};
