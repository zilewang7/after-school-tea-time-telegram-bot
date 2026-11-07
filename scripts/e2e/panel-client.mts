/**
 * The panel API the way the Mini App calls it: initData signed on the spot
 * with the test bot's token (scripts/lib/init-data.mts) and sent in the
 * X-Init-Data header — never in a URL, never printed.
 *
 * Reached through the public test domain (Cloudflare → Traefik → the test
 * container), so a run also proves the compose labels and the certificate.
 * PANEL_E2E_BASE_URL overrides it, e.g. with the container's address on
 * traefik-net.
 */
import { match } from 'ts-pattern';
import { signInitData, unixNow, type InitDataUserInput } from '../lib/init-data.mts';
import {
    readEnvValue,
    readStoredSender,
    sendAsUser,
    sleep,
    waitForStoredMessage,
} from './harness.mts';

export const PANEL_BASE_URL = (process.env.PANEL_E2E_BASE_URL ?? 'https://miniapp-test.heimaois.me').replace(
    /\/+$/,
    ''
);

const TEST_BOT_TOKEN = readEnvValue('BOT_TOKEN');

/** .env.test sets a synthetic owner who is not in the test group: the observer */
export const SYNTHETIC_OWNER: InitDataUserInput = { id: Number(readEnvValue('OWNER_USER_ID')), first_name: 'e2e-owner' };
/** Neither the owner nor a member of anything */
export const STRANGER: InitDataUserInput = { id: SYNTHETIC_OWNER.id + 1, first_name: 'e2e-stranger' };

/** How a request authenticates */
export type PanelAuth =
    | {
          kind: 'signed';
          user: InitDataUserInput;
          startParam?: string;
          /** How long ago the initData claims to have been issued */
          ageSeconds?: number;
      }
    /** A header value as is (tampered, malformed) */
    | { kind: 'raw'; initData: string }
    | { kind: 'none' };

export interface PanelResponse {
    status: number;
    body: unknown;
    headers: Headers;
}

/** initData for `user` signed with the test bot's token, as Telegram would issue it */
export const signedInitData = (
    user: InitDataUserInput,
    options: { startParam?: string; ageSeconds?: number } = {}
): string =>
    signInitData({
        botToken: TEST_BOT_TOKEN,
        user,
        authDate: unixNow() - (options.ageSeconds ?? 0),
        ...(options.startParam !== undefined ? { startParam: options.startParam } : {}),
    });

const initDataOf = (auth: PanelAuth): string | null =>
    match(auth)
        .with({ kind: 'signed' }, (signed) => signedInitData(signed.user, signed))
        .with({ kind: 'raw' }, (raw) => raw.initData)
        .with({ kind: 'none' }, () => null)
        .exhaustive();

const parseBody = (text: string): unknown => {
    if (text === '') return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
};

export const panelRequest = async (
    path: string,
    auth: PanelAuth,
    options: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown } = {}
): Promise<PanelResponse> => {
    const headers: Record<string, string> = {};
    const initData = initDataOf(auth);
    if (initData !== null) headers['x-init-data'] = initData;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${PANEL_BASE_URL}${path}`, {
        method: options.method ?? 'GET',
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    return { status: response.status, body: parseBody(await response.text()), headers: response.headers };
};

/** Signed as `user`, the common case */
export const asUser = (user: InitDataUserInput, startParam?: string): PanelAuth => ({
    kind: 'signed',
    user,
    ...(startParam !== undefined ? { startParam } : {}),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** A nested JSON field, undefined anywhere along a missing path */
export const fieldOf = (value: unknown, ...path: string[]): unknown =>
    path.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value);

export const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const errorCodeOf = (response: PanelResponse): unknown => fieldOf(response.body, 'error', 'code');

/** One line for an assertion message, never the request */
export const describe = (response: PanelResponse): string =>
    `${response.status} ${JSON.stringify(response.body ?? null).slice(0, 160)}`;

/**
 * Poll /api/health until the panel answers. A fresh test container needs the
 * bot to start and, the first time, Traefik to obtain the certificate (~80s).
 */
export const waitForPanel = async (timeoutMs = 180_000): Promise<PanelResponse> => {
    const deadline = Date.now() + timeoutMs;
    let lastProblem = 'no attempt';
    while (Date.now() < deadline) {
        try {
            const health = await panelRequest('/api/health', { kind: 'none' });
            if (health.status === 200) return health;
            lastProblem = describe(health);
        } catch (error) {
            lastProblem = error instanceof Error ? error.message : String(error);
        }
        await sleep(3000);
    }
    throw new Error(`the panel at ${PANEL_BASE_URL} never answered /api/health (${lastProblem})`);
};

let driverUserPromise: Promise<InitDataUserInput> | undefined;

/**
 * The userbot that drives the suite, a real member of the test group, with
 * the names the bot's roster already has (the panel writes them back).
 */
export const driverUser = (): Promise<InitDataUserInput> => {
    driverUserPromise ??= (async (): Promise<InitDataUserInput> => {
        const probe = await sendAsUser('面板 e2e：确认驱动账号');
        await waitForStoredMessage(probe);
        const sender = await readStoredSender(probe);
        if (!sender) throw new Error('the probe message was stored without a known sender');
        return {
            id: sender.userId,
            first_name: sender.firstName,
            ...(sender.lastName ? { last_name: sender.lastName } : {}),
            ...(sender.username ? { username: sender.username } : {}),
        };
    })().catch((error: unknown) => {
        driverUserPromise = undefined;
        throw error;
    });
    return driverUserPromise;
};
