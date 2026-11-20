import { Fragment, useMemo } from 'react';
import type { ModelCatalogEntryView, ModelTraitReconciliationRow } from '../../api';
import { platformLabel } from '../../format-metrics';
import {
    capabilityFactsOf,
    fieldProvenanceFactsOf,
    modelCatalogBadgesOf,
    modelReconciliationFactsOf,
} from './model-catalog-format';

interface ModelCapabilityCardProps {
    entry: ModelCatalogEntryView;
    reconciliationRow?: ModelTraitReconciliationRow;
}

/** One catalog row: header, badges, capability facts, per-field provenance, and reconciliation diffs */
export const ModelCapabilityCard = ({ entry, reconciliationRow }: ModelCapabilityCardProps) => {
    const facts = useMemo(() => capabilityFactsOf(entry), [entry]);
    const badges = useMemo(() => modelCatalogBadgesOf(entry), [entry]);
    const provenanceFacts = useMemo(() => fieldProvenanceFactsOf(entry), [entry]);
    const reconciliationDiffs = useMemo(
        () => (reconciliationRow === undefined ? [] : modelReconciliationFactsOf(reconciliationRow)),
        [reconciliationRow]
    );
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
                {reconciliationDiffs.length > 0 && (
                    <span className="badge warning">{reconciliationDiffs.length} 项代码差异</span>
                )}
            </p>
            <dl className="facts">
                {facts.map((fact) => (
                    <Fragment key={fact.label}>
                        <dt>{fact.label}</dt>
                        <dd>{fact.value}</dd>
                    </Fragment>
                ))}
            </dl>
            <p className="hint">字段来源</p>
            <dl className="facts">
                {provenanceFacts.map((fact) => (
                    <Fragment key={fact.field}>
                        <dt>{fact.label}</dt>
                        <dd>{fact.summary}</dd>
                    </Fragment>
                ))}
            </dl>
            {reconciliationDiffs.length > 0 && (
                <>
                    <p className="hint">对账差异</p>
                    <dl className="facts">
                        {reconciliationDiffs.map((diff) => (
                            <Fragment key={diff.field}>
                                <dt>{diff.label}</dt>
                                <dd>{diff.detail}</dd>
                            </Fragment>
                        ))}
                    </dl>
                </>
            )}
        </li>
    );
};
