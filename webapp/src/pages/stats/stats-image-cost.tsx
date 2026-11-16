import type { ImageCostGroupView } from '../../api';
import { formatCount, formatUsd, pricingLabel } from '../../format-metrics';

interface StatsImageCostProps {
    /** One row per image model seen in the range's in-reply generations */
    rows: readonly ImageCostGroupView[];
    /** The image part of the estimate; null when nothing in the range is priced */
    totalUsd: number | null;
    generations: number;
}

/**
 * 「生图」: the in-reply `generate_image` spend of the range (design D6), one
 * line per image model. Nothing is shown when the range has no generations, so
 * the section only appears where it means something.
 */
export const StatsImageCost = ({ rows, totalUsd, generations }: StatsImageCostProps) => {
    if (generations === 0) return null;
    return (
        <section className="section">
            <h2 className="section-title">生图</h2>
            <p className="hint">
                共 {formatCount(generations)} 张 · 估算 {formatUsd(totalUsd)} · 按官方标价估算；/pic 与 /vid
                的 GPU 成本不计
            </p>
            <ul className="list">
                {rows.map((row) => (
                    <li key={row.model} className="model-stats-row">
                        <div className="model-stats-head">
                            <span className="truncate">{row.model}</span>
                            <span className="model-stats-cost">
                                {formatUsd(row.costUsd)}{' '}
                                <span className="hint">{pricingLabel(row.pricing)}</span>
                            </span>
                        </div>
                        <p className="hint">{formatCount(row.generations)} 张</p>
                    </li>
                ))}
            </ul>
        </section>
    );
};
