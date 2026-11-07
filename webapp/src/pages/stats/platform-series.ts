import type { ModelStatsRow, StatsSeries } from '../../api';
import { platformLabel } from '../../format-metrics';
import type { StackedSeries } from './charts/stacked-bar-chart';

const PLATFORM_ORDER: readonly string[] = ['gemini', 'openai', 'anthropic', 'deepseek', 'grok', 'mimo', 'other'];

const KNOWN_PLATFORMS: ReadonlySet<string> = new Set(PLATFORM_ORDER);

/** Fixed colour per platform, never per rank (design §7) */
export const platformColorClassOf = (platform: string): string =>
    `series-${KNOWN_PLATFORMS.has(platform) ? platform : 'other'}`;

/**
 * The per-model reply lines folded into per-platform lines: models carry their
 * platform in `models`, so a stack is stable as models come and go.
 */
export const platformSeriesOf = (
    series: StatsSeries,
    models: readonly ModelStatsRow[]
): StackedSeries[] => {
    const platformOfModel = new Map(models.map((row) => [row.model, row.platform]));
    const valuesByPlatform = new Map<string, number[]>();
    for (const line of series.byModel) {
        const platform = platformOfModel.get(line.key) ?? 'other';
        const values = valuesByPlatform.get(platform) ?? series.buckets.map(() => 0);
        line.values.forEach((value, index) => {
            values[index] = (values[index] ?? 0) + value;
        });
        valuesByPlatform.set(platform, values);
    }
    return PLATFORM_ORDER.filter((platform) => valuesByPlatform.has(platform)).map((platform) => ({
        key: platform,
        label: platform === 'other' ? '其他' : platformLabel(platform),
        values: valuesByPlatform.get(platform) ?? [],
        colorClass: platformColorClassOf(platform),
    }));
};
