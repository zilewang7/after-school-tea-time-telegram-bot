/**
 * Offline cases for the panel's initData verification: a known-answer vector
 * (hash computed independently with Python's hmac), sign/verify round trips,
 * `signature` being part of the signed data, tampering, the read / write age
 * windows and the future-time limit.
 *
 * Run: npx tsx scripts/offline/panel-init-data.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import {
    PLACEHOLDER_SIGNATURE,
    READ_MAX_AGE_SECONDS,
    WRITE_MAX_AGE_SECONDS,
    resignInitData,
    signInitData,
    tamperInitData,
    verify,
} from '../lib/init-data.mts';
import {
    buildDataCheckString,
    computeInitDataHash,
    verifyInitData,
} from '../../src/panel/auth/init-data.js';

const BOT_TOKEN = '123456789:AAFakeOfflineTokenForPanelTests_0123';
const OTHER_TOKEN = '987654321:AAAnotherFakeTokenThatIsNotOurs_9876';
const NOW = 1_762_473_600;

/**
 * Known answer: the hash below was computed outside this code base
 * (`hmac.new(hmac.new(b'WebAppData', token, sha256).digest(), dcs, sha256)` in
 * Python) over these exact fields, signature included. The second hash is
 * the same data-check-string without the signature line: the wrong algorithm.
 */
const VECTOR_FIELDS: readonly [string, string][] = [
    ['query_id', 'AAHdF6IQAAAAAN0XohDhrOrc'],
    [
        'user',
        '{"id":279058397,"first_name":"Vladislav","last_name":"Kibenko","username":"vdkfrost","language_code":"ru","is_premium":true,"allows_write_to_pm":true}',
    ],
    ['auth_date', String(NOW)],
    ['start_param', 'c-1001234567890'],
    ['signature', '6fbdaab833d39f54518bd5c3eb3f511d035e68cb'],
];
const VECTOR_HASH = 'c9238cc3017b4eda998d0aa5cb38307337db17a56b6c658d0b1783aa25b9a29c';
const VECTOR_HASH_WITHOUT_SIGNATURE = '0d53b695b0d2f04d8a3e881ccc5e8d9d78946b90ba054e43ed6eb448d481c18e';

const vectorRaw = (hash: string): string => {
    const fields = new URLSearchParams(VECTOR_FIELDS.map(([key, value]) => [key, value]));
    fields.set('hash', hash);
    return fields.toString();
};

const USER = { id: 5001, first_name: 'Azusa', last_name: 'Nakano', username: 'azunyan' };

const signedAt = (authDate: number, startParam?: string): string =>
    signInitData({
        botToken: BOT_TOKEN,
        user: USER,
        authDate,
        queryId: 'AAQueryIdForOfflineCases',
        ...(startParam !== undefined ? { startParam } : {}),
    });

const reasonOf = (raw: string | undefined, options: { maxAgeSeconds?: number; nowSeconds?: number } = {}): string => {
    const result = verifyInitData(raw, BOT_TOKEN, {
        maxAgeSeconds: options.maxAgeSeconds ?? READ_MAX_AGE_SECONDS,
        nowSeconds: options.nowSeconds ?? NOW,
    });
    return result.ok ? 'ok' : result.reason;
};

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'the known-answer vector verifies, and only with the signature signed',
        body: async () => {
            const params = new URLSearchParams(vectorRaw(VECTOR_HASH));
            expect(
                computeInitDataHash(buildDataCheckString(params), BOT_TOKEN) === VECTOR_HASH,
                'our hash equals the independently computed one'
            );
            expect(reasonOf(vectorRaw(VECTOR_HASH), { nowSeconds: NOW + 10 }) === 'ok', 'the vector verifies');
            expect(
                reasonOf(vectorRaw(VECTOR_HASH_WITHOUT_SIGNATURE), { nowSeconds: NOW + 10 }) === 'bad_hash',
                'a hash that left the signature out is refused'
            );
            const result = verifyInitData(vectorRaw(VECTOR_HASH), BOT_TOKEN, {
                maxAgeSeconds: READ_MAX_AGE_SECONDS,
                nowSeconds: NOW + 10,
            });
            expect(
                result.ok &&
                    result.data.user.id === 279058397 &&
                    result.data.user.firstName === 'Vladislav' &&
                    result.data.user.lastName === 'Kibenko' &&
                    result.data.user.username === 'vdkfrost' &&
                    result.data.startParam === 'c-1001234567890' &&
                    result.data.authDate === NOW,
                'user, start_param and auth_date come back parsed'
            );
        },
    },
    {
        name: 'a signed payload round-trips; field order does not matter',
        body: async () => {
            const raw = signedAt(NOW, 'i42');
            const result = verify(raw, BOT_TOKEN, { nowSeconds: NOW });
            expect(result.ok, 'verifies');
            expect(result.ok && result.data.startParam === 'i42', 'start_param kept');
            const reordered = new URLSearchParams([...new URLSearchParams(raw).entries()].reverse()).toString();
            expect(reasonOf(reordered) === 'ok', 'the same fields in another order still verify');
            const withoutStart = verify(signedAt(NOW), BOT_TOKEN, { nowSeconds: NOW });
            expect(withoutStart.ok && withoutStart.data.startParam === null, 'no start_param reads as null');
            const bare = signInitData({ botToken: BOT_TOKEN, user: { id: 7, first_name: 'Ui' }, authDate: NOW });
            const bareResult = verify(bare, BOT_TOKEN, { nowSeconds: NOW });
            expect(
                bareResult.ok && bareResult.data.user.lastName === null && bareResult.data.user.username === null,
                'absent last name and username read as null'
            );
        },
    },
    {
        name: 'names with &, spaces, CJK and emoji survive the encoding',
        body: async () => {
            const raw = signInitData({
                botToken: BOT_TOKEN,
                user: { id: 5002, first_name: '中野 梓 & co', last_name: '🎸 =+%', username: 'azu' },
                authDate: NOW,
            });
            const result = verify(raw, BOT_TOKEN, { nowSeconds: NOW });
            expect(result.ok && result.data.user.firstName === '中野 梓 & co', 'first name intact');
            expect(result.ok && result.data.user.lastName === '🎸 =+%', 'last name intact');
        },
    },
    {
        name: 'dropping signature breaks the hash',
        body: async () => {
            const raw = signedAt(NOW);
            expect(new URLSearchParams(raw).get('signature') === PLACEHOLDER_SIGNATURE, 'signed payloads carry one');
            const stripped = tamperInitData(raw, (fields) => fields.delete('signature'));
            expect(reasonOf(stripped) === 'bad_hash', 'without signature: bad_hash');
            const resignedWithout = resignInitData(raw, BOT_TOKEN, (fields) => fields.delete('signature'));
            expect(reasonOf(resignedWithout) === 'ok', 'payloads signed without one are still fine (old clients)');
        },
    },
    {
        name: 'tampering with any field, or another token, is bad_hash',
        body: async () => {
            const raw = signedAt(NOW, 'c-100');
            const tamperings: [string, (fields: URLSearchParams) => void][] = [
                ['user id', (fields) => fields.set('user', JSON.stringify({ ...USER, id: 4242 }))],
                ['auth_date', (fields) => fields.set('auth_date', String(NOW + 1))],
                ['start_param', (fields) => fields.set('start_param', 'c-200')],
                ['signature', (fields) => fields.set('signature', `${PLACEHOLDER_SIGNATURE}x`)],
                ['query_id', (fields) => fields.set('query_id', 'other')],
                ['an added field', (fields) => fields.set('chat_type', 'group')],
                ['the hash itself', (fields) => fields.set('hash', `${'0'.repeat(63)}1`)],
                ['a non-hex hash', (fields) => fields.set('hash', 'z'.repeat(64))],
                ['a short hash', (fields) => fields.set('hash', 'abcd')],
            ];
            for (const [label, edit] of tamperings) {
                expect(reasonOf(tamperInitData(raw, edit)) === 'bad_hash', `${label} changed: bad_hash`);
            }
            const foreign = signInitData({ botToken: OTHER_TOKEN, user: USER, authDate: NOW });
            expect(reasonOf(foreign) === 'bad_hash', 'signed with another token: bad_hash');
            expect(
                (() => {
                    const result = verifyInitData(raw, '', { maxAgeSeconds: READ_MAX_AGE_SECONDS, nowSeconds: NOW });
                    return !result.ok && result.reason === 'bad_hash';
                })(),
                'an empty bot token accepts nothing'
            );
        },
    },
    {
        name: 'reads accept 24 hours, writes 5 minutes, both inclusive',
        body: async () => {
            const at = (age: number, maxAgeSeconds: number) =>
                reasonOf(signedAt(NOW - age), { maxAgeSeconds, nowSeconds: NOW });
            expect(at(READ_MAX_AGE_SECONDS, READ_MAX_AGE_SECONDS) === 'ok', 'read: exactly 24h old passes');
            expect(at(READ_MAX_AGE_SECONDS + 1, READ_MAX_AGE_SECONDS) === 'expired', 'read: one second more expires');
            expect(at(WRITE_MAX_AGE_SECONDS, WRITE_MAX_AGE_SECONDS) === 'ok', 'write: exactly 5 min old passes');
            expect(at(WRITE_MAX_AGE_SECONDS + 1, WRITE_MAX_AGE_SECONDS) === 'expired', 'write: one second more expires');
            expect(at(WRITE_MAX_AGE_SECONDS + 1, READ_MAX_AGE_SECONDS) === 'ok', 'the same payload is still fine to read');
        },
    },
    {
        name: 'auth_date more than 300s ahead is refused as future',
        body: async () => {
            expect(reasonOf(signedAt(NOW + 300)) === 'ok', '300s ahead passes (clock skew)');
            expect(reasonOf(signedAt(NOW + 301)) === 'future', '301s ahead: future');
            const garbled = resignInitData(signedAt(NOW), BOT_TOKEN, (fields) => fields.set('auth_date', 'soon'));
            expect(reasonOf(garbled) === 'expired', 'a signed but unparseable auth_date cannot prove freshness');
        },
    },
    {
        name: 'no initData, no hash or no usable user is missing',
        body: async () => {
            expect(reasonOf(undefined) === 'missing', 'header absent');
            expect(reasonOf('') === 'missing', 'header empty');
            expect(reasonOf(tamperInitData(signedAt(NOW), (fields) => fields.delete('hash'))) === 'missing', 'no hash');
            const noUser = resignInitData(signedAt(NOW), BOT_TOKEN, (fields) => fields.delete('user'));
            expect(reasonOf(noUser) === 'missing', 'signed without user');
            const badUser = resignInitData(signedAt(NOW), BOT_TOKEN, (fields) => fields.set('user', '{"id":"5001"}'));
            expect(reasonOf(badUser) === 'missing', 'signed with a malformed user');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
