import { Link } from 'react-router';

export const NotFoundPage = () => (
    <div className="placeholder">
        <p>页面不存在</p>
        <Link to="/">返回聊天列表</Link>
    </div>
);
