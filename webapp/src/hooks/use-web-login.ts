/**
 * State machine of the browser login page: load the public config, submit a code.
 *
 * Kept out of the component so the page stays a renderer and the failure
 * copy lives in one place.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createApi } from '../api';
import type { ApiFailure, WebConfigResponse } from '../api';

export type WebLoginConfigState =
    | { status: 'loading' }
    | { status: 'ready'; config: WebConfigResponse }
    | { status: 'error' };

export interface WebLoginSubmitState {
    submitting: boolean;
    error: string | null;
}

export interface WebLoginController {
    config: WebLoginConfigState;
    submit: WebLoginSubmitState;
    login: (code: string) => void;
}

const messageOfFailure = (failure: ApiFailure): string => {
    if (failure.kind === 'network') return '网络错误，请稍后再试';
    if (failure.kind === 'unreachable') return '服务暂时不可用，请稍后再试';
    if (failure.code === 'unauthorized') return '身份码无效或已过期';
    if (failure.code === 'rate_limited') return '尝试太频繁，请稍后再试';
    if (failure.message !== null) return failure.message;
    return '登录失败，请稍后再试';
};

export const useWebLogin = (): WebLoginController => {
    const api = useMemo(() => createApi(''), []);
    const [config, setConfig] = useState<WebLoginConfigState>({ status: 'loading' });
    const [submit, setSubmit] = useState<WebLoginSubmitState>({ submitting: false, error: null });

    useEffect(() => {
        const controller = new AbortController();
        void api.getWebConfig(controller.signal).then((result) => {
            if (controller.signal.aborted) return;
            setConfig(result.ok ? { status: 'ready', config: result.data } : { status: 'error' });
        });
        return () => controller.abort();
    }, [api]);

    const login = useCallback(
        (code: string) => {
            setSubmit({ submitting: true, error: null });
            void api.webLogin(code).then((result) => {
                if (result.ok) {
                    // The cookie is set; booting again picks it up
                    window.location.reload();
                    return;
                }
                setSubmit({ submitting: false, error: messageOfFailure(result.failure) });
            });
        },
        [api]
    );

    return { config, submit, login };
};
