import { ErrorView, LoadingView } from '../../components/status-views';
import { StatsRangePicker } from './stats-range-picker';
import { StatsView } from './stats-view';
import { useStats } from './use-stats';

interface StatsPageProps {
    // null = every chat (owner only)
    chatId: number | null;
}

/** One statistics page; the chat tab and the owner's home tab differ only in the scope */
export const StatsPage = ({ chatId }: StatsPageProps) => {
    const { state, setRange, retry, refreshing } = useStats(chatId);

    return (
        <>
            <div className="range-row">
                <StatsRangePicker range={state.range} onChange={setRange} />
            </div>
            {state.data === null ? (
                state.failure === null ? (
                    <LoadingView />
                ) : (
                    <ErrorView failure={state.failure} onRetry={retry} />
                )
            ) : (
                <>
                    {state.failure !== null && <p className="notice warning">更新失败，显示上次的结果</p>}
                    <StatsView data={state.data} refreshing={refreshing} />
                </>
            )}
        </>
    );
};
