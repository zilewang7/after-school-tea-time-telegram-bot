/**
 * Per-reply state of the workspace tools.
 *
 * The workspace is per conversation (reply-tree root), but one context may
 * splice other conversations in with `/chat <link>`. Those conversations get a
 * short token (`w2`, `w3`, …) so the model can address them without ever
 * seeing a raw message id; `w1` is always the conversation the reply happens
 * in. The manifest builder registers the tokens; the tools resolve them.
 *
 * There are no per-reply call counters: the workspace tools are local and
 * cheap, and the owner's rule is that a tool without cost is bounded by time,
 * never by a call count. The storage quotas are the only hard limits.
 */
import type { WorkspaceQuota } from '../../services/workspace-service.js';

/** The token the trigger's own conversation always gets */
export const CURRENT_WORKSPACE_TOKEN = 'w1';

export interface WorkspaceRef {
    readonly token: string;
    readonly rootId: number;
    /** Model-facing label, e.g. `本会话` or `拼接的会话 #12` */
    readonly label: string;
}

export interface WorkspaceState {
    readonly chatId: number;
    readonly quota: WorkspaceQuota;
    /** token → conversation; `w1` exists from the start */
    readonly refs: Map<string, WorkspaceRef>;
}

export interface CreateWorkspaceStateInput {
    readonly chatId: number;
    /** Current conversation first */
    readonly conversationRootIds: readonly number[];
    readonly quota: WorkspaceQuota;
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
        refs,
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
