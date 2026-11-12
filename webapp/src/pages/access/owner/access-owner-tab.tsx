import { AccessFilterBar } from './access-filter-bar';
import { AccessListView } from './access-list-view';
import { useAccessList } from './use-access-list';

/** /access for the owner: the review queue, 待审核 first by default */
export const AccessOwnerTab = () => {
    const list = useAccessList();
    const data = list.query.state.status === 'success' ? list.query.state.data : null;

    return (
        <section className="section">
            <AccessFilterBar filter={list.filter} data={data} onChange={list.setFilter} />
            <AccessListView list={list} />
        </section>
    );
};
