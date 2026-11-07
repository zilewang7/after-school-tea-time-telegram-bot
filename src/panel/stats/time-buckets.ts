/**
 * Calendar buckets for the statistics series, in the bot's time zone (TZ,
 * else Asia/Shanghai, the same default the runtime block uses). Labels are
 * local: `2026-11-06` for days, `2026-11-06 14:00` for hours.
 */
import type { StatsBucket } from './stats-window.js';

const FALLBACK_TIME_ZONE = 'Asia/Shanghai';
const HOUR_MS = 60 * 60 * 1000;
/** Walking step when listing day buckets; short enough that no local day is skipped across DST */
const DAY_WALK_STEP_MS = 6 * HOUR_MS;

const partsFormatterFor = (timeZone: string): Intl.DateTimeFormat =>
    new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
    });

/** An unknown TZ value would throw here: fall back instead of breaking the panel */
const createPartsFormatter = (): Intl.DateTimeFormat => {
    try {
        return partsFormatterFor(process.env.TZ || FALLBACK_TIME_ZONE);
    } catch {
        return partsFormatterFor(FALLBACK_TIME_ZONE);
    }
};

const localParts = createPartsFormatter();

export const STATS_TIME_ZONE = localParts.resolvedOptions().timeZone;

const partOf = (parts: readonly Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '00';

export const bucketLabelOf = (date: Date, bucket: StatsBucket): string => {
    const parts = localParts.formatToParts(date);
    const day = `${partOf(parts, 'year')}-${partOf(parts, 'month')}-${partOf(parts, 'day')}`;
    return bucket === 'day' ? day : `${day} ${partOf(parts, 'hour')}:00`;
};

/** Every bucket label from `start` to `end`, both included, oldest first */
export const bucketLabelsBetween = (start: Date, end: Date, bucket: StatsBucket): string[] => {
    const step = bucket === 'hour' ? HOUR_MS : DAY_WALK_STEP_MS;
    const labels = new Set<string>();
    for (let at = start.getTime(); at < end.getTime(); at += step) {
        labels.add(bucketLabelOf(new Date(at), bucket));
    }
    labels.add(bucketLabelOf(end, bucket));
    return [...labels];
};
