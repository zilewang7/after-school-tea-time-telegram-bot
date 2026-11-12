import type { AccessApplicationSummary } from '../../../api';
import { formatDateTime } from '../../../format';
import {
    accessApplicantLabel,
    accessApplicationSourceLabel,
    accessDeliveryLabel,
    accessSourceChatLabel,
} from '../access-labels';

interface AccessDetailFactsProps {
    application: AccessApplicationSummary;
}

/** Who applied, where from, when, and whether the outcome reached them */
export const AccessDetailFacts = ({ application }: AccessDetailFactsProps) => (
    <section className="section">
        <dl className="facts">
            <dt>申请人</dt>
            <dd>{accessApplicantLabel(application)}</dd>
            <dt>来源聊天</dt>
            <dd>{accessSourceChatLabel(application)}</dd>
            <dt>提交于</dt>
            <dd>{formatDateTime(application.createdAt)}</dd>
            <dt>审核于</dt>
            <dd>{application.reviewedAt === null ? '尚未审核' : formatDateTime(application.reviewedAt)}</dd>
            <dt>来源</dt>
            <dd>{accessApplicationSourceLabel(application.source)}</dd>
            <dt>结果投递</dt>
            <dd>
                {accessDeliveryLabel(application.deliveryStatus)}
                {application.deliveryError !== null && <span className="hint"> · {application.deliveryError}</span>}
            </dd>
        </dl>
    </section>
);
