import { Link } from 'react-router';
import { HOME_PATH } from '../routing/paths';

/** Landing page for a startapp reply link the requester cannot open (startTarget access 'none') */
export const NoAccessPage = () => (
    <div className="placeholder">
        <p>这条回复对你不可见</p>
        <p className="hint">它所在的聊天可能已经对你关闭，或者这个链接指向的内容已被清理。</p>
        <Link to={HOME_PATH}>返回聊天列表</Link>
    </div>
);
