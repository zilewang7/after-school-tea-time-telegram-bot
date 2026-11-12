/**
 * How old a stored timestamp is, as `deploy:check` reads `bot_responses`.
 * Its own module because check.mts queries production as soon as it is
 * imported: the offline tests import this one to check that the reply
 * heartbeat writes a time the release check reads as recent.
 */

/** `2026-11-11 07:29:06.000 +00:00` as the database stores it; 0 when unreadable */
export const ageSecondsOf = (storedTimestamp: unknown, now: number = Date.now()): number => {
    const parsed = typeof storedTimestamp === 'string' ? Date.parse(storedTimestamp.replace(' ', 'T').replace(' ', '')) : NaN;
    return Number.isNaN(parsed) ? 0 : Math.round((now - parsed) / 1000);
};
