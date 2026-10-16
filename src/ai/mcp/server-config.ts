/**
 * MCP_SERVERS parsing.
 *
 * Every entry is validated on its own, so a typo in one server skips that
 * server only. Only key names ever reach the logs, never a value: entries
 * carry auth headers, and a JSON.parse error quotes the text around the typo.
 */
import { isJsonObject } from '../../shared/json-object.js';
import type { PlatformType } from '../types.js';
import type { McpServerConfig } from './types.js';

export interface McpServerEntry {
    readonly name: string;
    readonly config: McpServerConfig;
}

// A Record, so a platform added to PlatformType but not here fails to compile
const PLATFORM_TYPE_FLAGS: Record<PlatformType, true> = {
    openai: true,
    gemini: true,
    deepseek: true,
    grok: true,
    mimo: true,
    anthropic: true,
};
const PLATFORM_TYPES: readonly string[] = Object.keys(PLATFORM_TYPE_FLAGS);

/** Every key an entry may carry (see McpServerConfig) */
const ENTRY_KEYS: ReadonlySet<string> = new Set(['serverUrl', 'headers', 'excludePlatforms']);

const isPlatformType = (value: unknown): value is PlatformType =>
    typeof value === 'string' && PLATFORM_TYPES.includes(value);

const isHttpUrl = (value: unknown): value is string => {
    if (typeof value !== 'string' || !URL.canParse(value)) return false;
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
};

const isStringRecord = (value: unknown): value is Record<string, string> =>
    isJsonObject(value) && Object.values(value).every((item) => typeof item === 'string');

/** The entry as a config, or why it is unusable (the reason never quotes a value) */
const validateEntry = (value: unknown): McpServerConfig | string => {
    if (!isJsonObject(value)) return 'entry is not an object';

    // Fail closed on unknown keys too: a misspelt "excludePlatforms" would
    // otherwise hand the server's tools to the platforms it was meant to skip
    const unknownKeys = Object.keys(value).filter((key) => !ENTRY_KEYS.has(key));
    if (unknownKeys.length > 0) {
        return `unknown key(s) ${unknownKeys.join(', ')} (allowed: ${[...ENTRY_KEYS].join(', ')})`;
    }

    const { serverUrl, headers, excludePlatforms } = value;
    if (!isHttpUrl(serverUrl)) return 'serverUrl is not an http(s) URL';
    if (headers !== undefined && !isStringRecord(headers)) {
        return 'headers must map names to strings';
    }
    // Fail closed: a misspelt platform would otherwise hand it the excluded tools
    if (
        excludePlatforms !== undefined &&
        !(Array.isArray(excludePlatforms) && excludePlatforms.every(isPlatformType))
    ) {
        return `excludePlatforms must list platforms among ${PLATFORM_TYPES.join(', ')}`;
    }

    return {
        serverUrl,
        ...(headers === undefined ? {} : { headers }),
        ...(excludePlatforms === undefined ? {} : { excludePlatforms }),
    };
};

/** The usable entries of MCP_SERVERS, in config order */
export const parseMcpServers = (serversJson: string): McpServerEntry[] => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(serversJson);
    } catch {
        console.error('[mcp] MCP_SERVERS is not valid JSON; no MCP server is connected');
        return [];
    }
    if (!isJsonObject(parsed)) {
        console.error('[mcp] MCP_SERVERS must be a JSON object keyed by server name');
        return [];
    }

    const entries: McpServerEntry[] = [];
    for (const [name, value] of Object.entries(parsed)) {
        const config = validateEntry(value);
        if (typeof config === 'string') {
            console.warn(`[mcp] Skipping MCP server "${name}": ${config}`);
            continue;
        }
        entries.push({ name, config });
    }
    return entries;
};
