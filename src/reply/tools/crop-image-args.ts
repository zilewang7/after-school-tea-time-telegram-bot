/**
 * Arguments of crop_image, checked against the declared schema.
 *
 * The box comes in two shapes on purpose: a 3×3 cell for "the bottom-right
 * part" (no coordinates at all), or a named bbox with an explicit unit. The
 * unit is never guessed here — the sidecar converts norm1000 or pixels from
 * the source dimensions it sees, and answers 422 with those dimensions when
 * the box cannot be used.
 */
import { invalid, isAbsent, valid, type Field } from './media-tool-args.js';

/** The nine cells of the 3×3 grid, in reading order */
export const CROP_REGIONS = [
    'top-left',
    'top',
    'top-right',
    'left',
    'center',
    'right',
    'bottom-left',
    'bottom',
    'bottom-right',
] as const;

export type CropRegion = (typeof CROP_REGIONS)[number];

export interface CropImageBox {
    readonly x1: number;
    readonly y1: number;
    readonly x2: number;
    readonly y2: number;
}

export interface CropImageArgs {
    readonly source: string;
    readonly region?: CropRegion;
    readonly bbox?: CropImageBox;
    readonly unit: 'norm1000' | 'px';
    readonly scale?: number;
    readonly label?: string;
}

export type ParsedCropImageArgs =
    | { readonly ok: true; readonly args: CropImageArgs }
    | { readonly ok: false; readonly error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const CROP_REGION_SET: ReadonlySet<string> = new Set(CROP_REGIONS);

const isRegion = (value: string): value is CropRegion => CROP_REGION_SET.has(value);

/** One cell of the grid as a norm1000 box; boundaries split 1000 into thirds */
export const cropBoxOfRegion = (region: CropRegion): CropImageBox => {
    const index = CROP_REGIONS.indexOf(region);
    const column = index % 3;
    const row = Math.floor(index / 3);
    const edge = (step: number): number => Math.round((1000 * step) / 3);
    return {
        x1: edge(column),
        y1: edge(row),
        x2: edge(column + 1),
        y2: edge(row + 1),
    };
};

const parseNumber = (value: unknown, label: string): Field<number> =>
    typeof value === 'number' && Number.isFinite(value) ? valid(value) : invalid(`${label} 必须是数字`);

const parseBbox = (value: unknown): Field<CropImageBox> => {
    if (!isRecord(value)) return invalid('bbox 必须是 {x1,y1,x2,y2} 这样的对象');
    const x1 = parseNumber(value.x1, 'bbox.x1');
    const y1 = parseNumber(value.y1, 'bbox.y1');
    const x2 = parseNumber(value.x2, 'bbox.x2');
    const y2 = parseNumber(value.y2, 'bbox.y2');
    const problems = [x1, y1, x2, y2].flatMap((field) => (field.ok ? [] : field.problems));
    if (problems.length > 0) return invalid(problems.join('；'));
    if (!x1.ok || !y1.ok || !x2.ok || !y2.ok) return invalid('bbox 数值无效');
    return valid({ x1: x1.value, y1: y1.value, x2: x2.value, y2: y2.value });
};

const problemsOf = (fields: ReadonlyArray<Field<unknown>>): string[] =>
    fields.flatMap((field) => (field.ok ? [] : field.problems));

export const parseCropImageArgs = (args: Readonly<Record<string, unknown>>): ParsedCropImageArgs => {
    const rawSource = args.source;
    const source: Field<string> =
        typeof rawSource === 'string' && rawSource.trim() !== ''
            ? valid(rawSource.trim())
            : invalid('source 要写明图片来源，如 \'#12\'、\'img3\' 或 \'s2\'');

    const rawRegion = args.region;
    const region: Field<CropRegion | undefined> = isAbsent(rawRegion)
        ? valid(undefined)
        : typeof rawRegion === 'string' && isRegion(rawRegion)
          ? valid(rawRegion)
          : invalid(`region 只能是 ${CROP_REGIONS.join('/')} 之一`);

    const rawBbox = args.bbox;
    const bbox: Field<CropImageBox | undefined> = isAbsent(rawBbox) ? valid(undefined) : parseBbox(rawBbox);

    const rawUnit = args.unit;
    const unit: Field<'norm1000' | 'px'> = isAbsent(rawUnit)
        ? valid('norm1000')
        : rawUnit === 'norm1000' || rawUnit === 'px'
          ? valid(rawUnit)
          : invalid("unit 只能是 'norm1000'（默认，把图看作 0-1000 相对坐标）或 'px'（源图原始像素）");

    const rawScale = args.scale;
    const scale: Field<number | undefined> = isAbsent(rawScale)
        ? valid(undefined)
        : typeof rawScale === 'number' && Number.isFinite(rawScale) && rawScale >= 1 && rawScale <= 4
          ? valid(rawScale)
          : invalid('scale 必须是 1-4 之间的数字（省略=自动放大）');

    const rawLabel = args.label;
    const label: Field<string | undefined> = isAbsent(rawLabel)
        ? valid(undefined)
        : typeof rawLabel === 'string' && Array.from(rawLabel.trim()).length <= 40
          ? valid(rawLabel.trim() === '' ? undefined : rawLabel.trim())
          : invalid('label 最多 40 字');

    const problems = problemsOf([source, region, bbox, unit, scale, label]);
    if (problems.length > 0) {
        return { ok: false, error: `参数有误：\n${problems.map((problem) => `- ${problem}`).join('\n')}` };
    }
    if (!source.ok || !region.ok || !bbox.ok || !unit.ok || !scale.ok || !label.ok) {
        return { ok: false, error: '参数有误' };
    }
    const hasRegion = region.value !== undefined;
    const hasBbox = bbox.value !== undefined;
    if (hasRegion === hasBbox) {
        return {
            ok: false,
            error: '参数有误：\n- region 与 bbox 必须给且只给一个（region 用于“右下角那块”这类说法，bbox 用于给具体坐标）',
        };
    }
    return {
        ok: true,
        args: {
            source: source.value,
            ...(region.value === undefined ? {} : { region: region.value }),
            ...(bbox.value === undefined ? {} : { bbox: bbox.value }),
            unit: unit.value,
            ...(scale.value === undefined ? {} : { scale: scale.value }),
            ...(label.value === undefined ? {} : { label: label.value }),
        },
    };
};
