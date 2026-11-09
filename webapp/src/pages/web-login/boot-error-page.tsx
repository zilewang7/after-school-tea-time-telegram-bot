/**
 * Shown when the browser cannot even ask whether it is logged in (server down,
 * proxy error) — distinct from the login page, which means "not logged in yet".
 */
export const BootErrorPage = ({ onRetry }: { onRetry: () => void }) => (
    <div className="web-login">
        <h1 className="web-login-title">无法连接面板</h1>
        <p className="hint">服务暂时不可用，请稍后再试。</p>
        <button className="button primary" type="button" onClick={onRetry}>
            重试
        </button>
    </div>
);
