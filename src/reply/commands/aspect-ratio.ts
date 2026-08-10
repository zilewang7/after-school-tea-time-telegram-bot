/**
 * Pick the supported aspect ratio closest to an actual picture.
 *
 * H3 only offers a fixed list, so a 1080x2400 phone screenshot has to land on
 * one of them. Comparing in log space makes the choice symmetric: 1:1 is as far
 * from 2:1 as it is from 1:2, which a plain difference of ratios gets wrong.
 */
import { readImageSize } from '../../shared/image-size.js';

const parseRatio = (ratio: string): number | null => {
    const matched = ratio.match(/^(\d+):(\d+)$/);
    if (!matched) return null;
    const width = Number(matched[1]);
    const height = Number(matched[2]);
    return height > 0 ? width / height : null;
};

export const closestAspectRatio = (
    ratios: readonly string[],
    width: number,
    height: number
): string | null => {
    if (width <= 0 || height <= 0) return null;
    const target = Math.log(width / height);

    let best: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const ratio of ratios) {
        const value = parseRatio(ratio);
        if (value === null) continue;
        const distance = Math.abs(Math.log(value) - target);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = ratio;
        }
    }
    return best;
};

/** `null` when the picture's header can't be read — the caller keeps its default */
export const aspectRatioOfImage = (
    ratios: readonly string[],
    base64Image: string
): string | null => {
    const size = readImageSize(base64Image);
    return size === null ? null : closestAspectRatio(ratios, size.width, size.height);
};
