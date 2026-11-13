/**
 * Offline cases for the signed public search page pointer (design
 * 2026-1113-1831 §3.6): the URL a folded GoogleSearch footer links to.
 *
 * The token is the permission, so these cases pin the properties the page
 * relies on: deterministic per reply version, verifiable only with our secret,
 * separated from the other signed-URL families, and gone when the switch or the
 * public origin is missing.
 *
 * Run: npx tsx scripts/offline/search-page-signer.mts
 */
process.env.WEBAPP_PUBLIC_URL = 'https://miniapp.test';
process.env.BOT_TOKEN = '123456:test-bot-token';
delete process.env.SEARCH_LINK;

import { createHmac } from 'node:crypto';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';

const signer = await import('../../src/shared/search-page.js');
const { shareSecretOf } = await import('../../src/shared/share-secret.js');

const TARGET = { chatId: -1001415974153, firstMessageId: 1120801, versionId: 1 };

const results: CaseResult[] = [];

results.push(
    await runCase('the page pointer derives from the reply identity', async () => {
        const link = signer.searchPageLinkOf(TARGET);
        expect(link !== null, 'a configured public origin yields a link');
        if (link === null) return;
        expect(link.url === `https://miniapp.test/g/${link.token}`, `absolute URL (got ${link.url})`);
        expect(link.token.split('.').length === 2, 'token is payload.signature');
        const again = signer.searchPageLinkOf({ ...TARGET });
        expect(
            again !== null && again.token === link.token && again.url === link.url,
            'the same version always gets the same URL (replays cannot drift)'
        );
        const other = signer.searchPageLinkOf({ ...TARGET, versionId: 2 });
        expect(other !== null && other.token !== link.token, 'another version is another page');
    })
);

results.push(
    await runCase('the token verifies back to its version', async () => {
        const link = signer.searchPageLinkOf(TARGET);
        expect(link !== null, 'link exists');
        if (link === null) return;
        const target = signer.searchPageTargetOfToken(link.token);
        expect(
            target !== null &&
                target.chatId === TARGET.chatId &&
                target.firstMessageId === TARGET.firstMessageId &&
                target.versionId === TARGET.versionId,
            `round trip (got ${JSON.stringify(target)})`
        );
        const replayed = signer.searchPageLinkOfToken(link.token);
        expect(replayed !== null && replayed.url === link.url, 'a stored token replays the same URL');
    })
);

results.push(
    await runCase('a tampered or foreign token is rejected', async () => {
        const link = signer.searchPageLinkOf(TARGET);
        expect(link !== null, 'link exists');
        if (link === null) return;
        const dot = link.token.indexOf('.');
        const payload = link.token.slice(0, dot);
        const signature = link.token.slice(dot + 1);

        const flippedSignature = `${signature.slice(0, 3)}${signature.slice(3, 4) === 'A' ? 'B' : 'A'}${signature.slice(4)}`;
        const cases: Array<[string, string]> = [
            ['flipped signature', `${payload}.${flippedSignature}`],
            ['changed payload', `${Buffer.from('{"c":-1,"m":2,"v":3}', 'utf8').toString('base64url')}.${signature}`],
            ['missing signature', payload],
            ['missing payload', `.${signature}`],
            ['empty token', ''],
            ['junk', 'not-a-token'],
        ];
        for (const [name, token] of cases) {
            expect(signer.searchPageTargetOfToken(token) === null, `${name} is rejected`);
            expect(signer.searchPageLinkOfToken(token) === null, `${name} replays nothing`);
        }

        // The same payload signed with another family's key must not open this page
        const secret = createHmac('sha256', shareSecretOf(process.env.BOT_TOKEN ?? '', undefined))
            .update('k-on-bot-media-url')
            .digest();
        const foreignSignature = createHmac('sha256', secret).update(payload).digest('base64url');
        expect(
            signer.searchPageTargetOfToken(`${payload}.${foreignSignature}`) === null,
            'another signed-URL family cannot mint a search-page token'
        );
    })
);

results.push(
    await runCase('a different bot secret cannot mint or verify', async () => {
        const link = signer.searchPageLinkOf(TARGET);
        expect(link !== null, 'link exists');
        if (link === null) return;
        const original = process.env.BOT_TOKEN;
        try {
            process.env.BOT_TOKEN = '654321:another-bot-token';
            expect(signer.searchPageTargetOfToken(link.token) === null, 'a token from another secret is invalid');
            const minted = signer.searchPageLinkOf(TARGET);
            expect(minted !== null && minted.token !== link.token, 'another secret mints another token');
        } finally {
            if (original === undefined) delete process.env.BOT_TOKEN;
            else process.env.BOT_TOKEN = original;
        }
    })
);

results.push(
    await runCase('the switch and the public origin decide whether a page exists', async () => {
        expect(signer.searchLinkEnabled() === true, 'on by default with a public origin');

        process.env.SEARCH_LINK = '0';
        try {
            expect(signer.searchLinkEnabled() === false, 'SEARCH_LINK=0 turns it off');
            expect(
                signer.searchPageLinkOf(TARGET) !== null,
                'the pointer itself still derives (replays of old messages keep working)'
            );
        } finally {
            delete process.env.SEARCH_LINK;
        }

        const originalUrl = process.env.WEBAPP_PUBLIC_URL;
        try {
            delete process.env.WEBAPP_PUBLIC_URL;
            expect(signer.searchLinkEnabled() === false, 'no origin means no page');
            expect(signer.searchPageLinkOf(TARGET) === null, 'no origin means no new link');
        } finally {
            if (originalUrl === undefined) delete process.env.WEBAPP_PUBLIC_URL;
            else process.env.WEBAPP_PUBLIC_URL = originalUrl;
        }

        const link = signer.searchPageLinkOf(TARGET);
        expect(link !== null, 'the origin comes back with the env');
        if (link === null) return;
        const originalUrlAgain = process.env.WEBAPP_PUBLIC_URL;
        try {
            delete process.env.WEBAPP_PUBLIC_URL;
            expect(signer.searchPageLinkOfToken(link.token) === null, 'a stored token needs the origin at replay time');
        } finally {
            if (originalUrlAgain === undefined) delete process.env.WEBAPP_PUBLIC_URL;
            else process.env.WEBAPP_PUBLIC_URL = originalUrlAgain;
        }
    })
);

reportResults(results);
