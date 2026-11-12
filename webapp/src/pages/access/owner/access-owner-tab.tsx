import { useMe } from '../../../context/me-context';
import { AccessFilterBar } from './access-filter-bar';
import { AccessListView } from './access-list-view';
import { useAccessList } from './use-access-list';

const groupLabelOf = (title: string | null, chatId: number): string => title ?? `群 ${chatId}`;

/** /access for the owner: the review queue, 待审核 first by default */
export const AccessOwnerTab = () => {
    const list = useAccessList();
    const { me } = useMe();
    const data = list.query.state.status === 'success' ? list.query.state.data : null;
    const accessGroups = me.accessGroups ?? [];

    return (
        <section className="section">
            {accessGroups.length > 0 && (
                <p className="hint">
                    名单来源群：{accessGroups.map((group) => groupLabelOf(group.title, group.chatId)).join('、')}
                    。这些群的成员自动拥有完整功能，被移出群后自动降为体验用户。
                </p>
            )}
            <AccessFilterBar filter={list.filter} data={data} onChange={list.setFilter} />
            <AccessListView list={list} />
        </section>
    );
};
