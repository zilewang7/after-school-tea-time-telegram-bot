import { useCallback, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import { match } from 'ts-pattern';
import type { MemberUserNode, ModelView, ModelViewPart, ModelViewTurn, TreeNode } from '../../../api';
import { CollapsibleSection } from '../../../components/collapsible-section';
import { FoldableText } from '../../../components/foldable-text';
import { ModelPicker } from '../../../components/model-picker';
import { ErrorView, LoadingView } from '../../../components/status-views';
import { formatDateTime } from '../../../format';
import { useModelView } from './use-model-view';

const RUNTIME_MARKER = '[system] 运行时信息：';
const LATEST_OPTION = 'latest';
const EXCERPT_CHARS = 24;

const roleLabel = (role: ModelViewTurn['role']): string =>
    match(role)
        .returnType<string>()
        .with('user', () => '用户')
        .with('assistant', () => '模型')
        .with('system', () => '系统')
        .exhaustive();

/** The runtime block and the addendum ride the last user turn; they are highlighted */
const splitRuntime = (text: string): { body: string; runtime: string | null } => {
    const index = text.indexOf(RUNTIME_MARKER);
    if (index < 0) return { body: text, runtime: null };
    return { body: text.slice(0, index).trimEnd(), runtime: text.slice(index) };
};

interface ModelPartProps {
    part: ModelViewPart;
    // The last text part of the last user turn
    highlightRuntime: boolean;
}

const ModelPart = ({ part, highlightRuntime }: ModelPartProps) => {
    if (part.type !== 'text') return <p className="hint">[{part.text}]</p>;
    if (!highlightRuntime) return <FoldableText text={part.text} foldLines={10} />;
    const { body, runtime } = splitRuntime(part.text);
    return (
        <>
            {body !== '' && <FoldableText text={body} foldLines={10} />}
            {runtime !== null && (
                <FoldableText
                    text={runtime}
                    className="prewrap runtime-highlight"
                    foldLines={20}
                    foldChars={1200}
                />
            )}
        </>
    );
};

interface ModelTurnProps {
    turn: ModelViewTurn;
    highlightRuntime: boolean;
}

const ModelTurn = ({ turn, highlightRuntime }: ModelTurnProps) => (
    <li className="model-turn">
        <p className="model-turn-head">
            <span className="badge">{roleLabel(turn.role)}</span>
            <span className="hint">{turn.parts.length} 段</span>
        </p>
        {turn.parts.map((part, index) => (
            <ModelPart
                key={`${turn.role}-${index}`}
                part={part}
                highlightRuntime={highlightRuntime && index === turn.parts.length - 1}
            />
        ))}
    </li>
);

const excerptOf = (text: string | null): string => {
    if (text === null) return '（无正文）';
    const characters = Array.from(text.replace(/\s+/g, ' ').trim());
    return characters.length <= EXCERPT_CHARS ? characters.join('') : `${characters.slice(0, EXCERPT_CHARS).join('')}…`;
};

/** The user messages a retry could answer, as `at` choices */
const userMessagesOf = (nodes: readonly TreeNode[]): MemberUserNode[] =>
    nodes
        .filter((node): node is MemberUserNode => node.kind === 'user' && !node.redacted)
        .sort((left, right) => left.messageId - right.messageId);

interface ModelViewPanelProps {
    chatId: number;
    rootId: number;
    nodes: readonly TreeNode[];
    // The chat's own model, shown as the "follow the chat setting" option
    chatModel: string;
    models: readonly string[];
}

/** 模型视角: what a retry would send right now, and how it changes with another model */
export const ModelViewPanel = ({ chatId, rootId, nodes, chatModel, models }: ModelViewPanelProps) => {
    const { result, draft, setDraft, error, apply } = useModelView(chatId, rootId);
    const userMessages = useMemo(() => userMessagesOf(nodes), [nodes]);
    const [atDraft, setAtDraft] = useState<number | null>(null);

    const handleAtChange = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
        const value = event.target.value;
        setAtDraft(value === LATEST_OPTION ? null : Number(value));
    }, []);
    const handleApply = useCallback(() => apply(atDraft), [apply, atDraft]);

    const lastUserTurnIndex = useMemo(() => {
        if (result.state.status !== 'success') return -1;
        const turns = result.state.data.turns;
        for (let index = turns.length - 1; index >= 0; index -= 1) {
            if (turns[index]?.role === 'user') return index;
        }
        return -1;
    }, [result.state]);

    return (
        <>
            <section className="section">
                <p className="hint">
                    等同于现在对一条回复点重试：重新构建上下文，不是当时请求的快照（媒体、缓存与设置都可能已经变了）。
                </p>
                <div className="field-group">
                    <label htmlFor="model-view-model" className="field-label">
                        模型
                    </label>
                    <ModelPicker
                        inputId="model-view-model"
                        models={models}
                        draft={draft}
                        unsetLabel={`本聊天的模型（当前为 ${chatModel}）`}
                        error={error}
                        disabled={result.state.status === 'loading'}
                        onChange={setDraft}
                    />
                </div>
                <div className="field-group">
                    <label htmlFor="model-view-at" className="field-label">
                        看哪条消息的重试
                    </label>
                    <select
                        id="model-view-at"
                        className="field"
                        value={atDraft === null ? LATEST_OPTION : String(atDraft)}
                        onChange={handleAtChange}
                    >
                        <option value={LATEST_OPTION}>最新一条（默认）</option>
                        {userMessages.map((node) => (
                            <option key={node.messageId} value={String(node.messageId)}>
                                #{node.number ?? '—'} {node.author.name}：{excerptOf(node.text)}
                            </option>
                        ))}
                    </select>
                </div>
                <button
                    type="button"
                    className="button primary"
                    disabled={result.state.status === 'loading' || error !== null}
                    onClick={handleApply}
                >
                    {result.state.status === 'loading' ? '计算中…' : '重新计算'}
                </button>
            </section>

            {match(result.state)
                .with({ status: 'loading' }, () => <LoadingView />)
                .with({ status: 'error' }, ({ failure }) => (
                    <ErrorView failure={failure} onRetry={result.reload} />
                ))
                .with({ status: 'success' }, ({ data }) => (
                    <ModelViewResult data={data} lastUserTurnIndex={lastUserTurnIndex} />
                ))
                .exhaustive()}
        </>
    );
};

interface ModelViewResultProps {
    data: ModelView;
    lastUserTurnIndex: number;
}

const ModelViewResult = ({ data, lastUserTurnIndex }: ModelViewResultProps) => (
    <>
        <section className="section">
            <p className="badges">
                <span className="badge accent">{data.model}</span>
                {data.asModel && <span className="badge">换个模型看</span>}
                {data.excludedReplyId !== null && (
                    <span className="badge">已排除重试的那条回复 #{data.excludedReplyId}</span>
                )}
            </p>
            <p className="hint">重算于 {formatDateTime(data.computedAt)} · 触发消息 #{data.at}</p>
            <CollapsibleSection
                title={data.systemPromptReplaced ? '生成指令（替代静态头）' : '静态头'}
                summary={`${Array.from(data.systemPrompt).length} 字`}
            >
                <pre className="code-block">{data.systemPrompt}</pre>
            </CollapsibleSection>

            <CollapsibleSection
                title="本轮声明的工具"
                summary={data.tools.length === 0 ? '无' : `${data.tools.length} 个`}
            >
                {data.tools.length === 0 ? (
                    <p className="hint">本轮没有声明工具</p>
                ) : (
                    <p className="tool-names">{data.tools.join(' · ')}</p>
                )}
            </CollapsibleSection>

            <CollapsibleSection title="编号对照" summary={`${data.numbers.length} 条`}>
                <ul className="list compact">
                    {data.numbers.map((entry) => (
                        <li key={entry.number} className="hint">
                            #{entry.number} → messageId {entry.messageId}
                        </li>
                    ))}
                </ul>
            </CollapsibleSection>
        </section>

        <section className="section">
            <h2 className="section-title">模型看到的上下文（{data.turns.length} 个 turn）</h2>
            {data.turns.length === 0 ? (
                <p className="placeholder">上下文是空的</p>
            ) : (
                <ul className="model-turns">
                    {data.turns.map((turn, index) => (
                        <ModelTurn
                            key={`${turn.role}-${index}`}
                            turn={turn}
                            highlightRuntime={index === lastUserTurnIndex}
                        />
                    ))}
                </ul>
            )}
        </section>
    </>
);
