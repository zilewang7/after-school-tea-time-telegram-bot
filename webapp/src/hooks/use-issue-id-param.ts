import { useParams } from 'react-router';

const ISSUE_ID_PATTERN = /^\d{1,10}$/;

/** :issueId from the route, or null when it is not a usable issue id */
export const useIssueIdParam = (): number | null => {
    const { issueId: rawIssueId } = useParams();
    if (rawIssueId === undefined || !ISSUE_ID_PATTERN.test(rawIssueId)) return null;
    const issueId = Number(rawIssueId);
    return issueId >= 1 ? issueId : null;
};
