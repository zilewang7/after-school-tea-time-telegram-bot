import { useMemo } from 'react';
import { match } from 'ts-pattern';
import { ErrorView, LoadingView } from '../../components/status-views';
import { useChatScope } from '../../context/chat-scope-context';
import { chatLabelOf } from '../../format';
import { ToolList } from './tool-list';

/** /c/:chatId/settings/tools: the full tool list behind the settings tab's summary row */
export const ChatToolsPage = () => {
    const { header, detail } = useChatScope();
    const subtitle = useMemo(() => (header === null ? null : chatLabelOf(header.name)), [header]);

    return (
        <>
            <header className="page-header">
                <h1>工具</h1>
                {subtitle !== null && <p className="hint">{subtitle}</p>}
            </header>
            <section className="section">
                {match(detail.state)
                    .with({ status: 'loading' }, () => <LoadingView />)
                    .with({ status: 'error' }, ({ failure }) => <ErrorView failure={failure} onRetry={detail.reload} />)
                    .with({ status: 'success' }, ({ data }) => (
                        <>
                            <p className="hint">当前模型 {data.effectiveModel} 在本聊天可用的工具</p>
                            <ToolList tools={data.tools} />
                        </>
                    ))
                    .exhaustive()}
            </section>
        </>
    );
};
