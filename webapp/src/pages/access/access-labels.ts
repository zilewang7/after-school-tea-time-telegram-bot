// Access application vocabulary: the known values and how the panel names them.

import { match } from 'ts-pattern';
import type {
    AccessApplicationSource,
    AccessApplicationStatus,
    AccessApplicationSummary,
    AccessDeliveryStatus,
} from '../../api';
import { chatTypeLabel } from '../../format';

const STATUS_LABELS: Record<AccessApplicationStatus, string> = {
    pending: '待审核',
    approved: '已通过',
    rejected: '已拒绝',
};

const SOURCE_LABELS: Record<AccessApplicationSource, string> = {
    command: '命令',
    miniapp: 'Mini App',
};

const DELIVERY_LABELS: Record<AccessDeliveryStatus, string> = {
    sent: '已发送',
    failed: '发送失败',
};

export const accessStatusLabel = (status: AccessApplicationStatus): string => STATUS_LABELS[status];

/** Badge colour of a status: pending warns, approved succeeds, rejected stays neutral */
export const accessStatusBadgeClass = (status: AccessApplicationStatus): string =>
    match(status)
        .with('pending', () => 'badge warning')
        .with('approved', () => 'badge success')
        .otherwise(() => 'badge');

export const accessApplicationSourceLabel = (source: AccessApplicationSource): string => SOURCE_LABELS[source];

/** How the outcome reached the applicant's chat; null = not delivered yet */
export const accessDeliveryLabel = (status: AccessDeliveryStatus | null): string =>
    status === null ? '未投递' : DELIVERY_LABELS[status];

/** The chat the application was filed from */
export const accessSourceChatLabel = (application: AccessApplicationSummary): string =>
    application.chatTitle ??
    `${application.chatType === null ? '聊天' : chatTypeLabel(application.chatType)} ${application.chatId}`;

/** "Name · @handle · id 123"; the @handle is left out when the applicant has none */
export const accessApplicantLabel = (application: AccessApplicationSummary): string => {
    const username = application.username === null ? null : `@${application.username}`;
    return [application.userName, username, `id ${application.userId}`].filter((part) => part !== null).join(' · ');
};
