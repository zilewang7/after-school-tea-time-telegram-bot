/**
 * The browser session's only control (design §4.3): a way to drop the cookie.
 * Rendered only when /api/me says the credential is a web session, so the
 * Telegram Mini App never shows it.
 */
import { useCallback, useState } from 'react';
import { useApi } from '../../context/panel-context';
import { useMe } from '../../context/me-context';

export const WebSessionCard = () => {
    const { me } = useMe();
    const api = useApi();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const logout = useCallback(() => {
        setBusy(true);
        setError(null);
        void api.webLogout().then((result) => {
            if (result.ok) {
                window.location.reload();
                return;
            }
            setBusy(false);
            setError('退出失败，请重试');
        });
    }, [api]);

    if (me.authenticatedBy !== 'web') return null;

    return (
        <section className="section">
            <h2 className="section-title">网页登录</h2>
            <p className="hint">当前是浏览器会话（由身份码换取，30 天内有效）。退出后需要重新获取身份码。</p>
            <button className="button secondary" type="button" onClick={logout} disabled={busy}>
                {busy ? '退出中…' : '退出登录'}
            </button>
            {error !== null && <p className="notice warning">{error}</p>}
        </section>
    );
};
