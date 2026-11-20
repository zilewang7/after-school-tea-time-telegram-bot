import { useCallback, useMemo } from 'react';
import { match } from 'ts-pattern';
import type { ModelCatalogResponse, ModelTraitReconciliationRow } from '../../api';
import { ErrorView, LoadingView } from '../../components/status-views';
import { useMe } from '../../context/me-context';
import { useApi } from '../../context/panel-context';
import { useApiQuery } from '../../hooks/use-api-query';
import { ModelCapabilityCard } from './model-capability-card';
import { modelCatalogMetaTextOf } from './model-catalog-format';
import { ModelReconciliationCard } from './model-reconciliation-card';

const CatalogContent = ({ data }: { data: ModelCatalogResponse }) => {
    const reconciliationByModel = useMemo(() => {
        const map = new Map<string, ModelTraitReconciliationRow>();
        for (const row of data.reconciliation?.rows ?? []) {
            map.set(row.model.toLowerCase(), row);
        }
        return map;
    }, [data.reconciliation]);

    const menuModels = useMemo(() => data.models.filter((entry) => entry.enabled), [data.models]);
    const referenceModels = useMemo(() => data.models.filter((entry) => !entry.enabled), [data.models]);

    return (
        <>
            <p className="hint">{modelCatalogMetaTextOf(data)}</p>
            <p className="hint">能力变更通过私聊里的审批按钮应用</p>
            {data.reconciliation !== undefined && (
                <ModelReconciliationCard reconciliation={data.reconciliation} />
            )}
            <h2 className="section-title">菜单模型（{menuModels.length}）</h2>
            <ul className="list">
                {menuModels.map((entry) => (
                    <ModelCapabilityCard
                        key={entry.id}
                        entry={entry}
                        reconciliationRow={reconciliationByModel.get(entry.id.toLowerCase())}
                    />
                ))}
            </ul>
            {menuModels.length === 0 && <p className="placeholder">目录里还没有已启用的菜单模型。</p>}
            {referenceModels.length > 0 && (
                <>
                    <h2 className="section-title">参考行 / 已停用（{referenceModels.length}）</h2>
                    <p className="hint">仅作运行时能力与价格参考，不出现在聊天菜单中</p>
                    <ul className="list">
                        {referenceModels.map((entry) => (
                            <ModelCapabilityCard
                                key={entry.id}
                                entry={entry}
                                reconciliationRow={reconciliationByModel.get(entry.id.toLowerCase())}
                            />
                        ))}
                    </ul>
                </>
            )}
        </>
    );
};

/** /settings/model-catalog (owner only): the read-only model capability catalog */
export const ModelCatalogPage = () => {
    const api = useApi();
    const { me } = useMe();
    // Disabled/reference rows stay visible here: the page is an inventory, not the menu
    const load = useCallback((signal: AbortSignal) => api.getModelCatalog(true, signal), [api]);
    const { state, reload } = useApiQuery(load);

    return (
        <>
            <header className="page-header">
                <h1>模型能力目录</h1>
                <p className="hint">按字段记录来源，并与代码兜底对账</p>
            </header>
            <section className="section">
                {!me.isOwner && <p className="placeholder">仅机主可以查看模型能力目录</p>}
                {me.isOwner &&
                    match(state)
                        .with({ status: 'loading' }, () => <LoadingView />)
                        .with({ status: 'error' }, ({ failure }) => <ErrorView failure={failure} onRetry={reload} />)
                        .with({ status: 'success' }, ({ data }) => <CatalogContent data={data} />)
                        .exhaustive()}
            </section>
        </>
    );
};
