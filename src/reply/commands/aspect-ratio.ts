/**
 * Aspect ratios for `/vid`.
 *
 * The backend used to take a fixed list; since 2.3.1 it takes any `宽:高`
 * between 1:4 and 4:1, integer or decimal. So a reference picture no longer has
 * to be snapped onto a whitelist — its own shape can be sent as it is.
 *
 * Formatting still prefers a shape people recognise. `1920x1080` reads better
 * as `16:9` than as `1.78:1`, and the backend quantises to a 32-pixel grid
 * anyway (~5% at 0.2 MP), so nudging a near-miss onto a familiar ratio changes
 * nothing anyone can see.
 */
import { readImageSize } from '../../shared/image-size.js';

/** The server's guard against a typo turning the canvas into a sliver */
export const MIN_ASPECT_RATIO = 0.25;
export const MAX_ASPECT_RATIO = 4;

/** `:` is what the API documents; the rest is what people type */
const RATIO_PATTERN = /^(\d+(?:\.\d+)?)\s*[:：xX×/]\s*(\d+(?:\.\d+)?)$/;

/** Shapes worth naming, when a picture lands close enough to one */
const NAMED_RATIOS = [
    '1:1', '5:4', '4:5', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '16:10', '10:16',
    '2:1', '1:2', '21:9', '9:21', '2.39:1', '1:2.39', '3:1', '1:3', '4:1', '1:4',
] as const;

/** Within this much of a named ratio, the 32-pixel grid erases the difference */
const SNAP_TOLERANCE = 0.02;

/** Past this a reduced pair stops being readable: `214:463` says nothing */
const MAX_READABLE_TERM = 64;

export interface AspectRatio {
    value: number;
    /** Normalised `宽:高`, which is what the API is given */
    text: string;
}

/** `null` for anything malformed or outside the server's range */
export const parseAspectRatio = (raw: string): AspectRatio | null => {
    const matched = raw.match(RATIO_PATTERN);
    if (!matched) return null;

    const width = Number(matched[1]);
    const height = Number(matched[2]);
    if (!(width > 0) || !(height > 0)) return null;

    const value = width / height;
    if (value < MIN_ASPECT_RATIO || value > MAX_ASPECT_RATIO) return null;
    return { value, text: `${width}:${height}` };
};

const greatestCommonDivisor = (a: number, b: number): number => (b === 0 ? a : greatestCommonDivisor(b, a % b));

const roundedToHundredths = (value: number): number => Math.round(value * 100) / 100;

/** The nearest named ratio, compared in log space so 1:2 and 2:1 are equidistant */
const nearestNamedRatio = (value: number): string | null => {
    const target = Math.log(value);
    let best: string | null = null;
    let bestDistance = SNAP_TOLERANCE;
    for (const ratio of NAMED_RATIOS) {
        const parsed = parseAspectRatio(ratio);
        if (parsed === null) continue;
        const distance = Math.abs(Math.log(parsed.value) - target);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = ratio;
        }
    }
    return best;
};

/** `1920x1080` → `16:9`, `1080x2400` → `9:20`, `1284x2778` → `1:2.16` */
export const formatAspectRatio = (width: number, height: number): string => {
    const exact = width / height;
    const value = Math.min(Math.max(exact, MIN_ASPECT_RATIO), MAX_ASPECT_RATIO);

    const named = nearestNamedRatio(value);
    if (named !== null) return named;

    // A clamped panorama is no longer the picture's own pixel counts
    if (value === exact && Number.isInteger(width) && Number.isInteger(height)) {
        const divisor = greatestCommonDivisor(width, height);
        const reducedWidth = width / divisor;
        const reducedHeight = height / divisor;
        if (reducedWidth <= MAX_READABLE_TERM && reducedHeight <= MAX_READABLE_TERM) {
            return `${reducedWidth}:${reducedHeight}`;
        }
    }

    return value >= 1 ? `${roundedToHundredths(value)}:1` : `1:${roundedToHundredths(1 / value)}`;
};

/** `null` when the picture's header can't be read — the caller keeps its default */
export const aspectRatioOfImage = (base64Image: string): string | null => {
    const size = readImageSize(base64Image);
    return size === null ? null : formatAspectRatio(size.width, size.height);
};
