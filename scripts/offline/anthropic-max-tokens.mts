/**
 * Offline unit cases for the max_tokens of an Anthropic request
 * (src/ai/platforms/anthropic/anthropic-max-tokens.ts): the model's output
 * limit from the catalog or the seed, 64000 without a usable number, and the
 * one-shot drop to 16000 that only a 400 naming max_tokens may trigger. The
 * wire side (bodies, tool rounds, the effort downgrade next to it) is in
 * platform-thinking-wire.mts.
 *
 * Run: pnpm test:offline anthropic-max-tokens
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';

type ModelCatalogEntry = import('../../src/config/model-catalog.js').ModelCatalogEntry;
type ModelCatalogCapabilities = import('../../src/config/model-capabilities.js').ModelCatalogCapabilities;

const { setModelCatalog } = await import('../../src/config/model-catalog.js');
const { emptyModelCapabilities } = await import('../../src/config/model-capabilities.js');
const {
    FALLBACK_MAX_TOKENS,
    UNKNOWN_MODEL_MAX_TOKENS,
    lowerMaxTokensAfter,
    maxTokensOf,
    maxTokensWireOf,
} = await import('../../src/ai/platforms/anthropic/anthropic-max-tokens.js');

const json = (value: unknown): string => JSON.stringify(value);

const capabilitiesWith = (outputTokens: number | null): ModelCatalogCapabilities => ({
    ...emptyModelCapabilities(),
    schema: 1,
    outputTokens,
});

const catalogRow = (id: string, outputTokens: number | null): ModelCatalogEntry => ({
    id,
    label: id,
    platform: 'anthropic',
    enabled: true,
    capabilities: capabilitiesWith(outputTokens),
    source: 'manual',
    checkedOn: '2026-11-14',
    confidence: 'high',
});

/** An SDK APIError as the helpers read it: a status and a message */
const apiError = (status: number, message: string) => ({ status, message: `${status} ${message}` });

const OVER_LIMIT = 'max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-x';

/** Run `body` with console.warn captured instead of printed */
const captureWarnings = <T,>(body: () => T): { result: T; lines: string[] } => {
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
    };
    try {
        return { result: body(), lines };
    } finally {
        console.warn = original;
    }
};

const results: CaseResult[] = [];

results.push(
    await runCase('maxTokensOf takes the output limit and falls back to 64000 without a usable one', () => {
        expect(UNKNOWN_MODEL_MAX_TOKENS === 64_000 && FALLBACK_MAX_TOKENS === 16_000, 'the two constants');
        expect(maxTokensOf(capabilitiesWith(128_000)) === 128_000, 'a catalog limit is used as is');
        expect(maxTokensOf(capabilitiesWith(8_192)) === 8_192, 'a small limit is used as is too');
        expect(maxTokensOf(null) === 64_000, 'no capabilities at all');
        expect(maxTokensOf(capabilitiesWith(null)) === 64_000, 'capabilities without an output limit');
        for (const broken of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(maxTokensOf(capabilitiesWith(broken)) === 64_000, `${String(broken)} is not a limit`);
        }
    })
);

results.push(
    await runCase('maxTokensWireOf reads the catalog row first, then the seed, then 64000', () => {
        try {
            setModelCatalog([]);
            expect(maxTokensWireOf('claude-opus-5-5').maxTokens === 128_000, 'the seed value of a shipped model');
            expect(maxTokensWireOf('Claude-Sonnet-5-5').maxTokens === 128_000, 'the id is matched case-insensitively');
            expect(maxTokensWireOf('claude-offline-unknown').maxTokens === 64_000, 'an id neither knows');
            expect(maxTokensWireOf('claude-opus-5-5').degraded === false, 'a reply starts undegraded');

            setModelCatalog([catalogRow('claude-opus-5-5', 100_000), catalogRow('claude-sonnet-5-5', null)], 'offline');
            expect(maxTokensWireOf('claude-opus-5-5').maxTokens === 100_000, 'a catalog row wins over the seed');
            expect(
                maxTokensWireOf('claude-sonnet-5-5').maxTokens === 64_000,
                'a catalog row without a number means unknown, not the seed value'
            );
        } finally {
            setModelCatalog([]);
        }
    })
);

results.push(
    await runCase('lowerMaxTokensAfter drops once on a 400 that names max_tokens and logs it', () => {
        const wire = { maxTokens: 128_000, degraded: false };
        const first = captureWarnings(() => lowerMaxTokensAfter(wire, 'claude-opus-5-5', apiError(400, OVER_LIMIT)));
        expect(first.result === true, 'the first rejection asks for a retry');
        expect(json(wire) === json({ maxTokens: 16_000, degraded: true }), `the wire holds 16000 (got ${json(wire)})`);
        expect(
            first.lines.length === 1 &&
                first.lines[0]?.includes('claude-opus-5-5 rejected max_tokens 128000; retrying with 16000') === true &&
                first.lines[0]?.includes('maximum allowed number of output tokens') === true,
            `one warn line with the model and the error text (got ${json(first.lines)})`
        );

        const second = captureWarnings(() => lowerMaxTokensAfter(wire, 'claude-opus-5-5', apiError(400, OVER_LIMIT)));
        expect(second.result === false && second.lines.length === 0, 'a second rejection is not retried and not logged');
        expect(wire.maxTokens === 16_000, 'the wire keeps 16000');
    })
);

results.push(
    await runCase('lowerMaxTokensAfter ignores other statuses, other 400s and a limit with nowhere to drop', () => {
        for (const status of [401, 403, 404, 429, 500, 503]) {
            const wire = { maxTokens: 128_000, degraded: false };
            const { result, lines } = captureWarnings(() => lowerMaxTokensAfter(wire, 'claude-x', apiError(status, OVER_LIMIT)));
            expect(result === false && !wire.degraded && lines.length === 0, `${status} never lowers max_tokens`);
        }

        const unrelated = { maxTokens: 128_000, degraded: false };
        expect(
            lowerMaxTokensAfter(unrelated, 'claude-x', apiError(400, 'messages.1.content: text content blocks must be non-empty')) ===
                false && !unrelated.degraded,
            'a 400 about something else is not a max_tokens rejection'
        );
        expect(
            lowerMaxTokensAfter(unrelated, 'claude-x', new Error('max_tokens over the limit')) === false,
            'an error without a status is not one either'
        );
        const nested = { maxTokens: 128_000, degraded: false };
        const relayed = captureWarnings(() =>
            lowerMaxTokensAfter(nested, 'claude-x', { status: 400, message: '400 upstream error', error: { message: OVER_LIMIT } })
        );
        expect(
            relayed.result === true && nested.maxTokens === 16_000,
            'the nested provider message counts like the top-level one'
        );

        // Input plus max_tokens over the context window: dropping max_tokens is what fixes it
        const overContext = { maxTokens: 128_000, degraded: false };
        const contextFull = captureWarnings(() =>
            lowerMaxTokensAfter(
                overContext,
                'claude-x',
                apiError(400, 'input length and `max_tokens` exceed context limit: 950000 + 128000 > 1000000, decrease input length or `max_tokens` and try again')
            )
        );
        expect(contextFull.result === true && overContext.maxTokens === 16_000, 'a context overflow that names max_tokens drops it');

        for (const limit of [16_000, 8_192]) {
            const wire = { maxTokens: limit, degraded: false };
            expect(
                lowerMaxTokensAfter(wire, 'claude-x', apiError(400, OVER_LIMIT)) === false && wire.maxTokens === limit,
                `${limit} has nothing lower to drop to`
            );
        }
    })
);

reportResults(results);
