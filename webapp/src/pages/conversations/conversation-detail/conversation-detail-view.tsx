import { useCallback, useMemo, useState } from 'react';
import type { ConversationTreeResponse } from '../../../api';
import { ConversationStatsPanel } from './conversation-stats-panel';
import { ExportMenu } from './export-menu';
import { LinksForm } from './links-form';
import { ModelViewPanel } from './model-view-panel';
import { TreeView } from './tree-view';

/** 树 / 模型视角 / 统计: a local segment, not a route (tab switches own the URL) */
export type ConversationSegment = 'tree' | 'model' | 'stats';

type OpenPanel = 'none' | 'links' | 'export';

interface ConversationDetailViewProps {
    chatId: number;
    tree: ConversationTreeResponse;
    segment: ConversationSegment;
    onSegmentChange: (segment: ConversationSegment) => void;
    // Re-reads the tree after an exclusion or a splice
    onChanged: () => void;
    models: readonly string[];
    // The chat's effective model, for the "follow the chat setting" option
    chatModel: string | null;
}

/** One conversation: the tree, its model view, its statistics, and the member-only actions */
export const ConversationDetailView = ({
    chatId,
    tree,
    segment,
    onSegmentChange,
    onChanged,
    models,
    chatModel,
}: ConversationDetailViewProps) => {
    const member = tree.access === 'member';
    const [panel, setPanel] = useState<OpenPanel>('none');

    const toggleLinks = useCallback(
        () => setPanel((current) => (current === 'links' ? 'none' : 'links')),
        []
    );
    const toggleExport = useCallback(
        () => setPanel((current) => (current === 'export' ? 'none' : 'export')),
        []
    );
    const closePanel = useCallback(() => setPanel('none'), []);

    const segments = useMemo(
        () => (
            <div className="segment-control" role="tablist" aria-label="会话视图">
                <button
                    type="button"
                    role="tab"
                    aria-selected={segment === 'tree'}
                    className="segment"
                    onClick={() => onSegmentChange('tree')}
                >
                    树
                </button>
                {member && (
                    <button
                        type="button"
                        role="tab"
                        aria-selected={segment === 'model'}
                        className="segment"
                        onClick={() => onSegmentChange('model')}
                    >
                        模型视角
                    </button>
                )}
                <button
                    type="button"
                    role="tab"
                    aria-selected={segment === 'stats'}
                    className="segment"
                    onClick={() => onSegmentChange('stats')}
                >
                    统计
                </button>
            </div>
        ),
        [segment, onSegmentChange, member]
    );

    if (segment === 'model' && member) {
        return (
            <>
                {segments}
                <ModelViewPanel
                    chatId={chatId}
                    rootId={tree.rootId}
                    nodes={tree.nodes}
                    chatModel={chatModel ?? '未知'}
                    models={models}
                />
            </>
        );
    }

    if (segment === 'stats') {
        return (
            <>
                {segments}
                <ConversationStatsPanel chatId={chatId} rootId={tree.rootId} />
            </>
        );
    }

    return (
        <>
            {segments}
            {member && (
                <div className="filter-row">
                    <button type="button" className="button secondary" onClick={toggleLinks}>
                        拼接对话
                    </button>
                    <button type="button" className="button secondary" onClick={toggleExport}>
                        导出
                    </button>
                </div>
            )}
            {panel === 'links' && (
                <LinksForm chatId={chatId} rootId={tree.rootId} onAttached={onChanged} onClose={closePanel} />
            )}
            {panel === 'export' && <ExportMenu chatId={chatId} rootId={tree.rootId} />}

            <section className="section">
                {tree.generating && (
                    <p className="hint">
                        <span className="generating-dot" aria-hidden="true" /> 有回复正在生成，每 5 秒自动刷新
                    </p>
                )}
                <TreeView chatId={chatId} tree={tree} member={member} onChanged={onChanged} />
            </section>
        </>
    );
};
