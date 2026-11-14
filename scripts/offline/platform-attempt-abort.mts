/**
 * Offline cases for the attempts of sendWithRetry on the SDK chat paths.
 *
 * The OpenAI and Anthropic SDK requests go out with maxRetries 0, so
 * src/shared/errors.ts must classify what the SDKs used to retry on their
 * own: connection errors, 408, 409, 429 and x-should-retry: true. Checked on
 * the SDKs' own error classes, so an SDK that renames them fails here.
 *
 * Run: npx tsx scripts/offline/platform-attempt-abort.mts
 */
import {
    APIConnectionError as AnthropicConnectionError,
    APIConnectionTimeoutError as AnthropicConnectionTimeoutError,
    APIError as AnthropicApiError,
    APIUserAbortError as AnthropicUserAbortError,
} from '@anthropic-ai/sdk';
import {
    APIConnectionError as OpenAIConnectionError,
    APIConnectionTimeoutError as OpenAIConnectionTimeoutError,
    APIError as OpenAIApiError,
    APIUserAbortError as OpenAIUserAbortError,
} from 'openai';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';

const { isRetryableError } = await import('../../src/shared/errors.js');

/** What both SDKs build from an HTTP error answer */
const openAIHttpError = (status: number, headers: Record<string, string> = {}): Error =>
    OpenAIApiError.generate(status, { error: { message: `upstream said ${status}` } }, undefined, new Headers(headers));
const anthropicHttpError = (status: number, headers: Record<string, string> = {}): Error =>
    AnthropicApiError.generate(status, { error: { message: `upstream said ${status}` } }, undefined, new Headers(headers));

const networkCause = (): Error => new TypeError('fetch failed', { cause: new Error('other side closed') });

const cases: Array<{ name: string; body: () => void | Promise<void> }> = [
    {
        name: 'what the SDKs retried on their own is retryable here',
        body: () => {
            const retryable: Array<[string, unknown]> = [
                ['openai connection error', new OpenAIConnectionError({ cause: networkCause() })],
                ['openai connection timeout', new OpenAIConnectionTimeoutError()],
                ['anthropic connection error', new AnthropicConnectionError({ cause: networkCause() })],
                ['anthropic connection timeout', new AnthropicConnectionTimeoutError()],
                ['openai 408', openAIHttpError(408)],
                ['openai 409', openAIHttpError(409)],
                ['anthropic 408', anthropicHttpError(408)],
                ['anthropic 409', anthropicHttpError(409)],
                ['a 429 whose message has no 429', { status: 429, message: 'Too Many Requests' }],
                ['openai 400 with x-should-retry: true', openAIHttpError(400, { 'x-should-retry': 'true' })],
                ['anthropic 400 with x-should-retry: true', anthropicHttpError(400, { 'x-should-retry': 'true' })],
            ];
            for (const [label, error] of retryable) {
                expect(isRetryableError(error), `${label} is retried`);
            }
        },
    },
    {
        name: 'what was retryable stays so, and a stop or a request error is still final',
        body: () => {
            const stillRetryable: Array<[string, unknown]> = [
                ['our own attempt timeout', new Error('Timeout')],
                ['openai 429', openAIHttpError(429)],
                ['anthropic 529', anthropicHttpError(529)],
                ['openai 503 with x-should-retry: false', openAIHttpError(503, { 'x-should-retry': 'false' })],
                ['a reset socket', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
            ];
            for (const [label, error] of stillRetryable) {
                expect(isRetryableError(error), `${label} is retried`);
            }
            const final: Array<[string, unknown]> = [
                ['openai user abort', new OpenAIUserAbortError()],
                ['anthropic user abort', new AnthropicUserAbortError()],
                ['openai 400', openAIHttpError(400)],
                ['anthropic 401', anthropicHttpError(401)],
                ['openai 404', openAIHttpError(404)],
                ['anthropic 413', anthropicHttpError(413)],
                ['openai 422', openAIHttpError(422)],
                ['a plain error that only reads like a connection error', new Error('Connection error.')],
            ];
            for (const [label, error] of final) {
                expect(!isRetryableError(error), `${label} is not retried`);
            }
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
