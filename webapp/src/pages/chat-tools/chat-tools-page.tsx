import { useCallback, useMemo, useState } from 'react';
import { match } from 'ts-pattern';
import { describeWriteFailure } from '../../api';
import type { ToolGroupEntry, ToolGroupKey, ToolOverrides, WriteFailureView } from '../../api';
import { ErrorView, LoadingView } from '../../components/status-views';
import { useChatScope } from '../../context/chat-scope-context';
import { useMe } from '../../context/me-context';
import { useApi } from '../../context/panel-context';
import { chatLabelOf } from '../../format';
import { useSuccessHaptic } from '../../hooks/use-telegram-feedback';
import { ToolList } from './tool-list';

type SaveStatus =
    | { kind: 'idle' }
    | { kind: 'saving'; key: ToolGroupKey }
    | { kind: 'failed'; view: WriteFailureView };

/** The switch object after one flip; flipping back to the env state drops the key */
const overridesAfterFlip = (
    group: ToolGroupEntry,
    next: boolean,
    current: ToolOverrides | null
): ToolOverrides | null => {
    const overrides: ToolOverrides = { ...current };
    if (next === group.defaultEnabled) delete overrides[group.key];
    else overrides[group.key] = next;
    return Object.keys(overrides).length === 0 ? null : overrides;
};

/** /c/:chatId/settings/tools: the tool groups and their per-chat switches */
export const ChatToolsPage = () => {
    const { header, detail } = useChatScope();
    const { me } = useMe();
    const api = useApi();
    const notifySaved = useSuccessHaptic();
    const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });
    const subtitle = useMemo(() => (header === null ? null : chatLabelOf(header.name)), [header]);

    const saveOverrides = useCallback(
        (next: ToolOverrides | null, key: ToolGroupKey) => {
            if (detail.state.status !== 'success') return;
            const { chat, settings } = detail.state.data;
            setSaveStatus({ kind: 'saving', key });
            // Lets the server reject the save with 409 when someone else changed the settings meanwhile
            const patch =
                settings.updatedAt === null
                    ? { toolOverrides: next }
                    : { toolOverrides: next, expectedUpdatedAt: settings.updatedAt };
            void api.patchChatSettings(chat.chatId, patch).then((result) => {
                if (!result.ok) {
                    setSaveStatus({ kind: 'failed', view: describeWriteFailure(result.failure) });
                    return;
                }
                setSaveStatus({ kind: 'idle' });
                notifySaved();
                // Re-read: enabled / reason follow the new switches
                detail.refresh();
            });
        },
        [api, detail, notifySaved]
    );

    const handleChange = useCallback(
        (group: ToolGroupEntry, next: boolean) => {
            if (detail.state.status !== 'success') return;
            saveOverrides(overridesAfterFlip(group, next, detail.state.data.settings.toolOverrides), group.key);
        },
        [detail.state, saveOverrides]
    );

    const handleReset = useCallback(
        (group: ToolGroupEntry) => {
            if (detail.state.status !== 'success') return;
            const overrides: ToolOverrides = { ...detail.state.data.settings.toolOverrides };
            delete overrides[group.key];
            saveOverrides(Object.keys(overrides).length === 0 ? null : overrides, group.key);
        },
        [detail.state, saveOverrides]
    );

    const savingKey = saveStatus.kind === 'saving' ? saveStatus.key : null;

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
                            <p className="hint">
                                当前模型 {data.effectiveModel}；开关只对本聊天生效，未覆盖的项跟随环境配置，保存后对本聊天后续回复生效。
                            </p>
                            {me.accessTier === 'trial' && (
                                <p className="notice warning">
                                    体验用户实际可用的工具更少：MCP 外部工具与付费生图（gpt/Grok）需要申请准入后才能使用。
                                </p>
                            )}
                            <ToolList
                                groups={data.tools}
                                canToggle={!data.settings.settingsLocked || me.isOwner}
                                isOwner={me.isOwner}
                                savingKey={savingKey}
                                onChange={handleChange}
                                onReset={handleReset}
                            />
                            {saveStatus.kind === 'failed' && (
                                <div className="save-failure">
                                    <p className="error-text">{saveStatus.view.message}</p>
                                    {saveStatus.view.suggestRefresh && (
                                        <button type="button" className="button secondary" onClick={detail.refresh}>
                                            刷新
                                        </button>
                                    )}
                                </div>
                            )}
                        </>
                    ))
                    .exhaustive()}
            </section>
        </>
    );
};
