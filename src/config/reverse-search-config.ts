/**
 * Settings of the search_by_image engines, read from the env once (on first use).
 *
 * - IMAGE_REVERSE_SEARCH_SAUCENAO=0: no SauceNAO supplement; auto stays Yandex
 *   only and naming the engine explicitly is an error
 * - SAUCENAO_API_KEY: the registered SauceNAO account's JSON API key (a secret,
 *   .env only). Empty = the SauceNAO engine is unavailable; a search that names
 *   it gets a readable error instead of a request
 * - SAUCENAO_MIN_INTERVAL_MS / SAUCENAO_DAILY_LIMIT / SAUCENAO_CIRCUIT_MS: the
 *   client's own pacing (defaults 10000 / 50 / 1800000)
 *
 * trace.moe needs no key; its guest quota is a constant of its client and the
 * engine only runs when a tool call names it.
 */
import type { EnvSource } from './env-source.js';

export interface ReverseSearchPacing {
    readonly minIntervalMs: number;
    readonly dailyLimit: number;
    readonly circuitMs: number;
}

export interface ReverseSearchConfig {
    /** The SauceNAO supplement engine may run (auto or explicit) */
    readonly sauceNaoEnabled: boolean;
    /** Empty when not configured */
    readonly sauceNaoApiKey: string;
    readonly sauceNaoPacing: ReverseSearchPacing;
}

/** A positive integer env value; anything else keeps the default */
const positiveInt = (raw: string | undefined, fallback: number): number => {
    const parsed = Number.parseInt((raw ?? '').trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** The settings in `env`; exported for tests, the app goes through getReverseSearchConfig */
export const readReverseSearchConfig = (env: EnvSource = process.env): ReverseSearchConfig => ({
    sauceNaoEnabled: env.IMAGE_REVERSE_SEARCH_SAUCENAO !== '0',
    sauceNaoApiKey: (env.SAUCENAO_API_KEY ?? '').trim(),
    sauceNaoPacing: {
        minIntervalMs: positiveInt(env.SAUCENAO_MIN_INTERVAL_MS, 10_000),
        dailyLimit: positiveInt(env.SAUCENAO_DAILY_LIMIT, 50),
        circuitMs: positiveInt(env.SAUCENAO_CIRCUIT_MS, 30 * 60 * 1000),
    },
});

let cachedConfig: ReverseSearchConfig | undefined;

export const getReverseSearchConfig = (): ReverseSearchConfig => {
    cachedConfig ??= readReverseSearchConfig();
    return cachedConfig;
};
