import { match } from 'ts-pattern';
import type { AccessApplicationSelf } from '../../../api';
import { formatDateTime } from '../../../format';
import { accessStatusBadgeClass, accessStatusLabel } from '../access-labels';

interface AccessStatusCardProps {
    application: AccessApplicationSelf | null;
    trialModel: string;
    /** The trial spend cap's amounts; null for the owner and full users */
    spend: { usedUsd: number; limitUsd: number } | null;
}

/** "体验额度：已用约 $1.23 / $3.00", with the spent-out state spelled out */
const quotaTextOf = (spend: NonNullable<AccessStatusCardProps['spend']>): string =>
    `体验额度：已用约 $${spend.usedUsd.toFixed(2)} / $${spend.limitUsd.toFixed(2)}` +
    (spend.usedUsd >= spend.limitUsd ? '（已用完，生成会被拒绝）' : '');

/** The applicant's current status, or what a trial user can do today */
export const AccessStatusCard = ({ application, trialModel, spend }: AccessStatusCardProps) => (
    <section className="section">
        <h2 className="section-title">当前状态</h2>
        {spend !== null && <p className="hint">{quotaTextOf(spend)}</p>}
        {match(application)
            .with(null, () => (
                <>
                    <p className="badges">
                        <span className="badge">未申请</span>
                    </p>
                    <p className="hint">
                        你当前是体验用户：模型固定为 {trialModel}，MCP 外部工具与付费生图不可用。
                    </p>
                    <p className="hint">
                        完整功能仅限机主、机主群聊的成员和已通过准入的用户；如果你在机主的群聊里，权限会自动恢复，无需申请。
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
