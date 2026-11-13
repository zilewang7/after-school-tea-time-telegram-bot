import { Fragment, useMemo } from 'react';
import type { ModelCatalogEntryView } from '../../api';
import { platformLabel } from '../../format-metrics';
import { capabilityFactsOf, modelCatalogBadgesOf } from './model-catalog-format';

interface ModelCapabilityCardProps {
    entry: ModelCatalogEntryView;
}

/** One catalog row: header, badges and the labeled capability facts (read only) */
export const ModelCapabilityCard = ({ entry }: ModelCapabilityCardProps) => {
    const facts = useMemo(() => capabilityFactsOf(entry), [entry]);
    const badges = useMemo(() => modelCatalogBadgesOf(entry), [entry]);
    const subtitle = useMemo(
        () => (entry.platform === null ? entry.id : `${entry.id} · ${platformLabel(entry.platform)}`),
        [entry.id, entry.platform]
    );

    return (
        <li className="model-stats-row">
            <div className="model-stats-head">
                <span className="truncate">{entry.label}</span>
                <span className="model-stats-cost">{entry.checkedOn}</span>
            </div>
            <p className="hint">{subtitle}</p>
            <p className="badges">
                {badges.map((badge) => (
                    <span key={badge} className="badge">
                        {badge}
                    </span>
                ))}
            </p>
            <dl className="facts">
                {facts.map((fact) => (
                    <Fragment key={fact.label}>
                        <dt>{fact.label}</dt>
                        <dd>{fact.value}</dd>
                    </Fragment>
                ))}
            </dl>
        </li>
    );
};
