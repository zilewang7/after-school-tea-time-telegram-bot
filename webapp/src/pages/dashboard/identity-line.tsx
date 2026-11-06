import type { ChatAccess, ChatType } from '../../api';
import { accessLabel, chatTypeLabel } from '../../format';

interface IdentityLineProps {
    type: ChatType;
    access: ChatAccess;
    locked: boolean;
}

export const IdentityLine = ({ type, access, locked }: IdentityLineProps) => (
    <>
        <p className="identity-line">
            <span>身份：{accessLabel(access)}</span>
            <span className="hint">{chatTypeLabel(type)}</span>
            <span className={locked ? 'badge warning' : 'badge'}>{locked ? '设置已锁定' : '设置未锁定'}</span>
        </p>
        {access === 'observer' && <p className="hint">你不在这个聊天里，只能看到 bot 自己的输出</p>}
    </>
);
