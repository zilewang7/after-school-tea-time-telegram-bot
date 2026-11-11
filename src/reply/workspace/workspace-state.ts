/**
 * Per-reply state of the workspace tools.
 *
 * The workspace is per conversation (reply-tree root), but one context may
 * splice other conversations in with `/chat <link>`. Those conversations get a
 * short token (`w2`, `w3`, …) so the model can address them without ever
 * seeing a raw message id; `w1` is always the conversation the reply happens
 * in. The manifest builder registers the tokens; the tools resolve them.
 *
 * The counters bound one reply's workspace calls: the tools are local and
 * cheap, so the tool-time budget would never stop a model that keeps reading or
 * rewriting the same file.
 */
import { match } from 'ts-pattern';
import type { WorkspaceQuota } from '../../services/workspace-service.js';

/** The token the trigger's own conversation always gets */
export const CURRENT_WORKSPACE_TOKEN = 'w1';

export type WorkspaceCallKind = 'write' | 'read' | 'list' | 'delete' | 'preview';

export interface WorkspaceCallLimits {
    readonly writes: number;
    readonly reads: number;
    readonly lists: number;
    readonly deletes: number;
    readonly previews: number;
}

export const WORKSPACE_CALL_LIMITS: WorkspaceCallLimits = {
    writes: 10,
    reads: 20,
    lists: 10,
    deletes: 10,
    // Per-reply preview renders also cost sidecar CPU; the env can lower it
    previews: 6,
};

export interface WorkspaceRef {
    readonly token: string;
    readonly rootId: number;
    /** Model-facing label, e.g. `本会话` or `拼接的会话 #12` */
    readonly label: string;
}

export interface WorkspaceState {
    readonly chatId: number;
    readonly quota: WorkspaceQuota;
    readonly callLimits: WorkspaceCallLimits;
    /** token → conversation; `w1` exists from the start */
    readonly refs: Map<string, WorkspaceRef>;
    /** How many calls of each kind this reply has made */
    readonly calls: Record<WorkspaceCallKind, number>;
}

export interface CreateWorkspaceStateInput {
    readonly chatId: number;
    /** Current conversation first */
    readonly conversationRootIds: readonly number[];
    readonly quota: WorkspaceQuota;
    readonly callLimits?: WorkspaceCallLimits;
}

export const createWorkspaceState = (input: CreateWorkspaceStateInput): WorkspaceState => {
    const refs = new Map<string, WorkspaceRef>();
    const currentRootId = input.conversationRootIds[0];
    if (currentRootId !== undefined) {
        refs.set(CURRENT_WORKSPACE_TOKEN, {
            token: CURRENT_WORKSPACE_TOKEN,
            rootId: currentRootId,
            label: '本会话',
        });
    }
    return {
        chatId: input.chatId,
        quota: input.quota,
        callLimits: input.callLimits ?? WORKSPACE_CALL_LIMITS,
        refs,
        calls: { write: 0, read: 0, list: 0, delete: 0, preview: 0 },
    };
};

/** The token a root already has, or the next free `wN` */
export const ensureWorkspaceToken = (state: WorkspaceState, rootId: number, label: string): string => {
    for (const ref of state.refs.values()) {
        if (ref.rootId === rootId) return ref.token;
    }
    const token = `w${state.refs.size + 1}`;
    state.refs.set(token, { token, rootId, label });
    return token;
};

export type WorkspaceRefResult =
    | { readonly ok: true; readonly ref: WorkspaceRef }
    | { readonly ok: false; readonly error: string };

/** Resolve the model's `workspace` argument; absent = the current conversation */
export const resolveWorkspaceRef = (
    state: WorkspaceState,
    workspace: unknown
): WorkspaceRefResult => {
    if (workspace === undefined || workspace === null || workspace === '') {
        const current = state.refs.get(CURRENT_WORKSPACE_TOKEN);
        return current === undefined
            ? { ok: false, error: '当前会话的工作区不可用。' }
            : { ok: true, ref: current };
    }
    if (typeof workspace !== 'string') {
        return { ok: false, error: 'workspace 要传字符串，如 "w1" 或 "w2"。' };
    }
    const ref = state.refs.get(workspace.trim());
    if (ref === undefined) {
        const available = [...state.refs.values()]
            .map((item) => `${item.token}（${item.label}）`)
            .join('、');
        return {
            ok: false,
            error: `没有 ${workspace} 这个工作区；本次上下文里可用的是：${available}。省略 workspace 就是当前会话。`,
        };
    }
    return { ok: true, ref };
};

const limitOf = (state: WorkspaceState, kind: WorkspaceCallKind): number =>
    match(kind)
        .with('write', () => state.callLimits.writes)
        .with('read', () => state.callLimits.reads)
        .with('list', () => state.callLimits.lists)
        .with('delete', () => state.callLimits.deletes)
        .with('preview', () => state.callLimits.previews)
        .exhaustive();

const limitName = (kind: WorkspaceCallKind): string =>
    match(kind)
        .with('write', () => '写入')
        .with('read', () => '读取')
        .with('list', () => '列目录')
        .with('delete', () => '删除')
        .with('preview', () => '预览')
        .exhaustive();

/**
 * Count one call of `kind`; returns an actionable error when this reply has
 * used its allowance. The caller must not run the operation on error.
 */
export const consumeWorkspaceCall = (state: WorkspaceState, kind: WorkspaceCallKind): string | null => {
    const limit = limitOf(state, kind);
    if (state.calls[kind] >= limit) {
        return `本次回复的工作区${limitName(kind)}次数已用完（${limit} 次）；请先收尾，或把剩余内容合并到更少的调用里。`;
    }
    state.calls[kind] += 1;
    return null;
};
