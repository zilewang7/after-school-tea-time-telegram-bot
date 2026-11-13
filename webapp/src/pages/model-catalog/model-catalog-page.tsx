import { useCallback } from 'react';
import { match } from 'ts-pattern';
import type { ModelCatalogResponse } from '../../api';
import { ErrorView, LoadingView } from '../../components/status-views';
import { useMe } from '../../context/me-context';
import { useApi } from '../../context/panel-context';
import { useApiQuery } from '../../hooks/use-api-query';
import { ModelCapabilityCard } from './model-capability-card';
import { modelCatalogMetaTextOf } from './model-catalog-format';

const CatalogContent = ({ data }: { data: ModelCatalogResponse }) => (
    <>
        <p className="hint">{modelCatalogMetaTextOf(data)}</p>
        <p className="hint">能力变更通过私聊里的审批按钮应用</p>
        <ul className="list">
            {data.models.map((entry) => (
                <ModelCapabilityCard key={entry.id} entry={entry} />
            ))}
        </ul>
        {data.models.length === 0 && <p className="placeholder">目录里还没有模型。</p>}
    </>
);

/** /settings/model-catalog (owner only): the read-only model capability catalog */
export const ModelCatalogPage = () => {
    const api = useApi();
    const { me } = useMe();
    // Disabled rows stay visible here: the page is an inventory, not the menu
    const load = useCallback((signal: AbortSignal) => api.getModelCatalog(true, signal), [api]);
    const { state, reload } = useApiQuery(load);

    return (
        <>
            <header className="page-header">
                <h1>模型能力目录</h1>
                <p className="hint">巡检与 probe 实测写入的能力数据</p>
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
