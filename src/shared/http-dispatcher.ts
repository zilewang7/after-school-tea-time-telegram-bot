import { Agent, fetch as undiciFetch } from 'undici';

// Node's built-in fetch aborts a request whose response header takes longer than
// 300s (UND_ERR_HEADERS_TIMEOUT) -- too tight for gs:// large media, where the
// upstream fetches and processes the whole video before it answers. The built-in
// fetch ignores setGlobalDispatcher from this package (it keeps its own copy of
// undici and its own dispatcher), so the global fetch is routed through ours
// instead. Callers still apply their own, tighter timeouts on top.
const RESPONSE_TIMEOUT_MS = 900_000;
const CONNECT_TIMEOUT_MS = 30_000;

const agent = new Agent({
    headersTimeout: RESPONSE_TIMEOUT_MS,
    bodyTimeout: RESPONSE_TIMEOUT_MS,
    connectTimeout: CONNECT_TIMEOUT_MS,
});

export const installHttpDispatcher = (): void => {
    // The two fetch typings come from different implementations, so one cast is
    // unavoidable here; the call shape is identical.
    const patchedFetch = ((input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
        undiciFetch(input, { ...init, dispatcher: agent })) as typeof fetch;

    globalThis.fetch = patchedFetch;
};
