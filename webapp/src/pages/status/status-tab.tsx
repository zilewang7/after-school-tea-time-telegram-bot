import { ErrorView, LoadingView } from '../../components/status-views';
import { ActiveReplies } from './active-replies';
import { ProcessCard } from './process-card';
import { StatusErrors } from './status-errors';
import { useStatus } from './use-status';

/** /status (owner): the bot process, the replies being generated and the recent errors */
export const HomeStatusTab = () => {
    const { data, failure, retry } = useStatus();

    if (data === null) {
        return failure === null ? <LoadingView /> : <ErrorView failure={failure} onRetry={retry} />;
    }

    return (
        <>
            {failure !== null && <p className="notice warning">更新失败，显示上次的状态</p>}
            {data.process !== null && <ProcessCard process={data.process} />}
            <ActiveReplies replies={data.active} />
            <StatusErrors errors={data.recentErrors} />
            <p className="hint">每 5 秒自动刷新</p>
        </>
    );
};
