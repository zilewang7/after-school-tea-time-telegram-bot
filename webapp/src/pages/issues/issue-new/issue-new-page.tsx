import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router';
import type { IssueDetail } from '../../../api';
import { useChatScope } from '../../../context/chat-scope-context';
import { useMe } from '../../../context/me-context';
import { chatLabelOf } from '../../../format';
import { useSuccessHaptic } from '../../../hooks/use-telegram-feedback';
import { useVerticalSwipeLock } from '../../../hooks/use-telegram-guards';
import { issuePath } from '../../../routing/paths';
import { clearIssueListSnapshots } from '../issue-list/issue-list-snapshots';
import { IssueForm } from './issue-form';

/** /c/:chatId/issues/new */
export const IssueNewPage = () => {
    const { chatId, header } = useChatScope();
    const { refreshMe } = useMe();
    const navigate = useNavigate();
    const notifyFiled = useSuccessHaptic();
    // The whole page is a form: a swipe down must not close the panel mid-sentence
    useVerticalSwipeLock(true);

    const subtitle = useMemo(() => (header === null ? null : chatLabelOf(header.name)), [header]);
    // While the chat type is still unknown the notice shows, to be on the safe side
    const showGroupNotice = header === null || header.type === 'group' || header.type === 'supergroup';

    const handleCreated = useCallback(
        (issue: IssueDetail) => {
            notifyFiled();
            // Every issue list changes, and so do the open counts on the badges
            clearIssueListSnapshots();
            refreshMe();
            // Replace: Back from the new issue goes to the list, not to an emptied form
            void navigate(issuePath(issue.id), { replace: true });
        },
        [notifyFiled, refreshMe, navigate]
    );

    return (
        <>
            <header className="page-header">
                <h1>提 issue</h1>
                {subtitle !== null && <p className="hint">{subtitle}</p>}
            </header>
            <IssueForm chatId={chatId} showGroupNotice={showGroupNotice} onCreated={handleCreated} />
        </>
    );
};
