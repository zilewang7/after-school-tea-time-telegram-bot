/**
 * The login page a plain browser gets instead of "请在 Telegram 里打开"
 * (design §4.2): paste the code `/web` sent, or open the Mini App instead.
 */
import { useCallback, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { useWebLogin } from '../../hooks/use-web-login';

const CodeForm = ({
    disabled,
    submitting,
    onSubmit,
}: {
    disabled: boolean;
    submitting: boolean;
    onSubmit: (code: string) => void;
}) => {
    const [code, setCode] = useState('');

    const changeOf = useCallback((event: ChangeEvent<HTMLInputElement>) => {
        setCode(event.target.value.toUpperCase());
    }, []);

    const submitOf = useCallback(
        (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (code.trim() === '' || disabled || submitting) return;
            onSubmit(code);
        },
        [code, disabled, onSubmit, submitting]
    );

    return (
        <form className="web-login-form" onSubmit={submitOf}>
            <label className="web-login-label" htmlFor="web-login-code">
                身份码
            </label>
            <input
                id="web-login-code"
                className="web-login-input"
                value={code}
                onChange={changeOf}
                placeholder="XXXX-XXXX"
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck={false}
                inputMode="text"
                disabled={disabled || submitting}
            />
            <button className="button primary" type="submit" disabled={disabled || submitting || code.trim() === ''}>
                {submitting ? '登录中…' : '登录'}
            </button>
        </form>
    );
};

export const WebLoginPage = () => {
    const { config, submit, login } = useWebLogin();

    if (config.status === 'loading') {
        return <div className="web-login" />;
    }

    const enabled = config.status === 'ready' ? config.config.webLoginEnabled : false;
    const botUsername = config.status === 'ready' ? config.config.botUsername : null;
    const miniAppUrl = config.status === 'ready' ? config.config.miniAppUrl : null;
    const botChatUrl = botUsername === null ? null : `https://t.me/${botUsername}`;

    return (
        <div className="web-login">
            <h1 className="web-login-title">k-on-bot 控制面板</h1>
            <p className="hint">浏览器里用身份码登录，与 Telegram 里打开的面板是同一份数据。</p>

            {enabled && (
                <section className="section web-login-section">
                    <h2 className="section-title">用身份码登录</h2>
                    <p className="hint">
                        在 bot 私聊发送 <code>/web</code> 获取身份码（5 分钟内有效，一次性）。
                        {botChatUrl !== null && (
                            <>
                                {' '}
                                <a href={botChatUrl} target="_blank" rel="noopener noreferrer">
                                    打开 bot 私聊
                                </a>
                            </>
                        )}
                    </p>
                    <CodeForm disabled={false} submitting={submit.submitting} onSubmit={login} />
                    {submit.error !== null && <p className="notice warning">{submit.error}</p>}
                </section>
            )}

            {!enabled && <p className="notice warning">网页登录未启用，只能在 Telegram 里打开面板。</p>}

            {miniAppUrl !== null && (
                <section className="section web-login-section">
                    <h2 className="section-title">或在 Telegram 里打开</h2>
                    <p className="hint">Telegram 客户端里不需要身份码。</p>
                    <a className="button secondary" href={miniAppUrl}>
                        在 Telegram 里打开面板
                    </a>
                </section>
            )}

            {config.status === 'error' && <p className="notice warning">读取登录配置失败，刷新页面重试。</p>}
        </div>
    );
};
