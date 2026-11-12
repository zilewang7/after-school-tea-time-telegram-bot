import { match } from 'ts-pattern';
import type { AccessApplicationSelf } from '../../../api';
import { formatDateTime } from '../../../format';
import { accessStatusBadgeClass, accessStatusLabel } from '../access-labels';

interface AccessStatusCardProps {
    application: AccessApplicationSelf | null;
    trialModel: string;
}

/** The applicant's current status, or what a trial user can do today */
export const AccessStatusCard = ({ application, trialModel }: AccessStatusCardProps) => (
    <section className="section">
        <h2 className="section-title">当前状态</h2>
        {match(application)
            .with(null, () => (
                <>
                    <p className="badges">
                        <span className="badge">未申请</span>
                    </p>
                    <p className="hint">
                        你当前是体验用户：模型固定为 {trialModel}，MCP 外部工具与付费生图不可用。
                    </p>
                </>
            ))
            .with({ status: 'pending' }, ({ createdAt }) => (
                <>
                    <p className="badges">
                        <span className={accessStatusBadgeClass('pending')}>{accessStatusLabel('pending')}</span>
                    </p>
                    <p>已提交，等待机主审核。</p>
                    <p className="hint">提交于 {formatDateTime(createdAt)}</p>
                </>
            ))
            .with({ status: 'rejected' }, ({ comment, createdAt }) => (
                <>
                    <p className="badges">
                        <span className={accessStatusBadgeClass('rejected')}>{accessStatusLabel('rejected')}</span>
                    </p>
                    <p>申请未通过。</p>
                    {comment !== null && <p className="prewrap">机主留言：{comment}</p>}
                    <p className="hint">提交于 {formatDateTime(createdAt)}</p>
                </>
            ))
            .with({ status: 'approved' }, () => (
                <>
                    <p className="badges">
                        <span className="badge warning">已取消</span>
                    </p>
                    <p>你之前的准入已被取消，可以重新提交申请。</p>
                </>
            ))
            .exhaustive()}
    </section>
);
