/**
 * The parts of a model id the catalog rules compare.
 *
 * - family: `gpt`, `gemini`, `claude-sonnet` — one vendor lineage per version;
 * - version: the number right after the family (`gpt-6.1` → 6.1);
 * - product line: the family plus the name that stays across versions
 *   (`gpt-sol`, `gemini-argon`, `claude-sonnet`) — one model's successive
 *   versions share a line, which is what "the newer version replaces the old"
 *   compares.
 *
 * Pure string parsing: the watcher's auto-add rule and the catalog storage
 * both need it, so it lives at the bottom layer.
 */

/** The family a version belongs to: `gpt`, `gemini`, `claude-sonnet`, ... */
export const familyLineOf = (id: string): string => {
    const tokens = id.toLowerCase().split('-');
    if (tokens[0] === 'claude' && tokens.length > 1) return `${tokens[0]}-${tokens[1]}`;
    return tokens[0] ?? id.toLowerCase();
};

/** The numeric version right after the family line (`gpt-6.1`, `claude-sonnet-5-5` → 5.5) */
export const versionOf = (id: string, familyLine: string): number | null => {
    const rest = id.toLowerCase().slice(familyLine.length + 1);
    const match = /^v?(\d+)(?:[.-](\d+))?/.exec(rest);
    if (match === null) return null;
    const major = Number(match[1]);
    const minor = match[2] === undefined ? 0 : Number(`0.${match[2]}`);
    return major + minor;
};

/** The product line an id belongs to, with the version removed: `gpt-sol` */
export const productLineOf = (id: string): string => {
    const normalized = id.toLowerCase();
    const family = familyLineOf(normalized);
    const rest = normalized.slice(family.length + 1);
    const version = /^v?\d+(?:[.-]\d+)?/.exec(rest);
    const persona = version === null ? rest : rest.slice(version[0].length).replace(/^-/, '');
    return persona === '' ? family : `${family}-${persona}`;
};

/**
 * Whether `candidateId` is a strictly newer version of the product line
 * `offeredId` belongs to — the rule that lets a newer minor replace its
 * predecessor and never the other way round.
 */
export const isNewerVersionOfSameLine = (candidateId: string, offeredId: string): boolean => {
    if (productLineOf(candidateId) !== productLineOf(offeredId)) return false;
    const candidateVersion = versionOf(candidateId, familyLineOf(candidateId));
    const offeredVersion = versionOf(offeredId, familyLineOf(offeredId));
    if (candidateVersion === null || offeredVersion === null) return false;
    return candidateVersion > offeredVersion;
};
