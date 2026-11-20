import { Fragment, useMemo, useState } from 'react';
import type { CatalogTraitsReconciliation, ModelTraitReconciliationRow } from '../../api';
import { platformLabel } from '../../format-metrics';
import {
    modelReconciliationFactsOf,
    modelTraitsOriginLabelOf,
    reconciliationSummaryTextOf,
} from './model-catalog-format';

interface ReconciliationRowItemProps {
    row: ModelTraitReconciliationRow;
}

const ReconciliationRowItem = ({ row }: ReconciliationRowItemProps) => {
    const diffs = useMemo(() => modelReconciliationFactsOf(row), [row]);
    return (
        <li className="model-stats-row">
            <div className="model-stats-head">
                <span className="truncate">{row.model}</span>
                <span className="model-stats-cost">{platformLabel(row.platform)}</span>
            </div>
            <p className="badges">
                <span className="badge">{modelTraitsOriginLabelOf(row.origin)}</span>
                <span className="badge">{row.enabled ? '菜单中' : '参考行'}</span>
                <span className="badge warning">{row.diffCount} 项差异</span>
            </p>
            <dl className="facts">
                {diffs.map((diff) => (
                    <Fragment key={diff.field}>
                        <dt>{diff.label}</dt>
                        <dd>{diff.detail}</dd>
                    </Fragment>
                ))}
            </dl>
        </li>
    );
};

interface ModelReconciliationCardProps {
    reconciliation: CatalogTraitsReconciliation;
}

/** Code-vs-data reconciliation table ("对账表") summary and per-model differences */
export const ModelReconciliationCard = ({ reconciliation }: ModelReconciliationCardProps) => {
    const [expanded, setExpanded] = useState(reconciliation.totalDiffs > 0);
    const summaryText = useMemo(() => reconciliationSummaryTextOf(reconciliation), [reconciliation]);
    const differingRows = useMemo(
        () => reconciliation.rows.filter((row) => row.diffCount > 0),
        [reconciliation.rows]
    );

    return (
        <section className="section">
            <div className="model-stats-head">
                <h2 className="section-title">对账表</h2>
                {differingRows.length > 0 && (
                    <button
                        type="button"
                        className="button-link"
                        onClick={() => setExpanded((previous) => !previous)}
                    >
                        {expanded ? '收起差异' : `展开 ${differingRows.length} 项`}
                    </button>
                )}
            </div>
            <p className="hint">{summaryText}</p>
            {differingRows.length === 0 && (
                <p className="badges">
                    <span className="badge success">目录与代码兜底完全一致</span>
                </p>
            )}
            {expanded && differingRows.length > 0 && (
                <ul className="list">
                    {differingRows.map((row) => (
                        <ReconciliationRowItem key={row.model} row={row} />
                    ))}
                </ul>
            )}
        </section>
    );
};
