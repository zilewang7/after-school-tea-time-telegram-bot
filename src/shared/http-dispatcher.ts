import { Agent, setGlobalDispatcher } from 'undici';

// Node's fetch aborts a request when the response header takes longer than 300s
// (UND_ERR_HEADERS_TIMEOUT), which is too tight for gs:// large media: the
// upstream fetches and processes the whole video before it answers. Raise the
// ceiling for the process -- callers still apply their own, tighter timeouts.
const RESPONSE_TIMEOUT_MS = 900_000;
const CONNECT_TIMEOUT_MS = 30_000;

export const installHttpDispatcher = (): void => {
    setGlobalDispatcher(
        new Agent({
            headersTimeout: RESPONSE_TIMEOUT_MS,
            bodyTimeout: RESPONSE_TIMEOUT_MS,
            connectTimeout: CONNECT_TIMEOUT_MS,
        })
    );
};
